/**
 * Bridges the cmd-backedges maze API to renderable geometry.
 *
 * The maze plane maps into world space as: plane X -> world X, plane Y ->
 * world Z (so maze north is -Z), extrusion depth -> world Y (up). One cell is
 * one plane unit, read as roughly two meters.
 *
 * Responsibilities:
 *  - own the MazeGenerator + MazeSession pair for one seed
 *  - stream chunk meshes around the player (floors, ceilings, extruded walls,
 *    light panels, furniture)
 *  - continuous-collision movement on top of the discrete isPassable() test
 *  - wallpaper zones: randomly shaped enclosed regions where the wallpaper
 *    tint and pattern change
 */
import {
  CellFeature,
  Direction,
  DIRECTIONS,
  hashCoords,
  MazeCell,
  MazeEdge,
  MazeGenerator,
  MazeSession,
  mulberry32,
  opposite,
  step,
  SurfaceType,
  unitFromHash,
  Vec2,
} from 'cmd-backedges';
import { MaterialPreset } from '../shared/settings';
import { ChunkMesh, EMISSIVE_SHADE, Renderer } from './renderer';
import { TILE } from './textures';

/** Ceiling height range in plane units; ~2.2m to ~3.2m at 2m cells. */
const DEPTH_RANGE = { min: 1.1, max: 1.6 };
/** Player collision radius in plane units. */
const PLAYER_RADIUS = 0.24;
/**
 * Half of a wall's extrusion depth: each cell insets its wall face this far
 * from the shared boundary line, so the two inward faces plus the jamb caps
 * read as one solid slab. Kept below PLAYER_RADIUS so collision never lets
 * the camera reach the face.
 */
const WALL_HALF_DEPTH = 0.06;
/** Doorway opening height as a fraction of the lower adjoining ceiling. */
const DOOR_TOP_FRACTION = 0.84;
/** Cells per streamed chunk side. */
const CHUNK_SIZE = 4;
/** Ceiling lights sit on a 3-cell lattice, jittered out occasionally. */
const LIGHT_LATTICE = 3;
/** Wallpaper zone anchors live on this lattice, in cells. */
const ZONE_LATTICE = 12;

// Salts for this renderer's own deterministic draws. Arbitrary values, far
// from anything the generator uses internally.
const SALT = {
  lightState: 7001,
  zoneAnchor: 7101,
  zoneCenterX: 7102,
  zoneCenterY: 7103,
  zoneRadius: 7104,
  zonePhase1: 7105,
  zonePhase2: 7106,
  zonePalette: 7107,
  zoneVariant: 7108,
} as const;

const WALL_TILE_BY_SURFACE: Record<SurfaceType, number> = {
  drywall: TILE.drywall,
  wallpaper: TILE.wallpaperA,
  paneling: TILE.paneling,
  concrete: TILE.concrete,
  tile: TILE.ceramic,
  carpet: TILE.carpet,
};

/**
 * Pre-built wall material sets. `tile: null` keeps the generator's per-edge
 * surface-type mix; a concrete tile forces every wall to that material.
 */
const MATERIAL_PRESETS: Record<MaterialPreset, { tile: number | null; tint: [number, number, number] }> = {
  classic: { tile: null, tint: [1, 1, 1] },
  office: { tile: TILE.drywall, tint: [1, 1, 1] },
  pool: { tile: TILE.ceramic, tint: [0.88, 1, 1.06] },
  concrete: { tile: TILE.concrete, tint: [1, 1, 1] },
  panel: { tile: TILE.paneling, tint: [1, 1, 1] },
};

/**
 * Wallpaper zone palettes: tint multipliers applied to wallpaper walls.
 * Deliberately strong, since they multiply an already-yellow material and
 * must survive the fog and film grain.
 */
const ZONE_PALETTES: readonly [number, number, number][] = [
  [1.1, 0.6, 0.52], // faded rose
  [0.58, 0.95, 0.38], // mossy green
  [0.5, 0.72, 1.1], // dusty blue
  [0.72, 0.5, 0.26], // deep sepia
  [1.35, 1.32, 1.12], // bleached bone
];

interface Zone {
  tint: [number, number, number];
  variant: boolean;
}

type LightState = 'on' | 'dead' | 'flicker';

export interface WorldStats {
  seed: number;
  cellsVisited: number;
  cacheSize: number;
}

const WHITE: [number, number, number] = [1, 1, 1];

export class World {
  readonly generator: MazeGenerator;
  readonly session: MazeSession;
  readonly seed: number;
  furnitureEnabled = true;
  // Off by default, matching DEFAULT_SETTINGS.wallpaperShifts.
  wallpaperShiftsEnabled = false;
  /**
   * When a photo wallpaper is loaded, the classic preset papers every wall
   * with it instead of the generator's mixed surface types; per-edge wear and
   * wallpaper zones still provide the variation.
   */
  uniformWallpaper = false;

  private wallOverrideTile: number | null = null;
  private wallBaseTint: [number, number, number] = [1, 1, 1];
  private cellsVisited = 1;
  private readonly zoneCache = new Map<string, Zone | null>();
  private readonly chunks = new Map<string, ChunkMesh>();

  constructor(seed: number) {
    this.seed = seed;
    this.generator = new MazeGenerator({
      seed,
      depth: DEPTH_RANGE,
      propFrequency: 0.14,
    });
    this.session = new MazeSession(this.generator);
    this.session.on('enterCell', () => {
      this.cellsVisited++;
    });
  }

  /**
   * Applies a wall material preset plus its adjustable elements (hue rotation
   * in degrees and a brightness multiplier). Call invalidateChunks afterwards
   * so existing meshes pick the change up.
   */
  setMaterial(preset: MaterialPreset, hueShiftDeg: number, brightness: number): void {
    const base = MATERIAL_PRESETS[preset] ?? MATERIAL_PRESETS.classic;
    this.wallOverrideTile = base.tile;
    this.wallBaseTint = hueRotate(base.tint, hueShiftDeg).map((v) =>
      Math.max(0, v * brightness),
    ) as [number, number, number];
  }

  stats(): WorldStats {
    return {
      seed: this.seed,
      cellsVisited: this.cellsVisited,
      cacheSize: this.generator.stats().size,
    };
  }

  /**
   * Keeps the discrete MazeSession in step with the continuous player
   * position, so its move/enterCell events stay meaningful.
   */
  syncSession(px: number, py: number): void {
    const cx = Math.floor(px);
    const cy = Math.floor(py);
    const at = this.session.player;
    if (at.cx === cx && at.cy === cy) {
      return;
    }
    const dx = cx - at.cx;
    const dy = cy - at.cy;
    if (Math.abs(dx) + Math.abs(dy) === 1) {
      const direction: Direction = dx === 1 ? 'east' : dx === -1 ? 'west' : dy === 1 ? 'south' : 'north';
      if (!this.session.move(direction)) {
        this.session.warpTo(cx, cy);
      }
    } else {
      this.session.warpTo(cx, cy);
    }
  }

  // --- Movement ------------------------------------------------------------

  /**
   * Moves the player from (px, py) toward (px+dx, py+dy) in plane coordinates,
   * resolving collisions per axis so the player slides along walls.
   */
  moveResolved(px: number, py: number, dx: number, dy: number): { x: number; y: number } {
    let x = px;
    let y = py;

    const tryAxis = (nx: number, ny: number, axis: 'x' | 'y'): void => {
      if (this.canOccupy(nx, ny)) {
        x = nx;
        y = ny;
        return;
      }
      // Clamp to the wall plane instead of stopping dead, so motion stays smooth.
      if (axis === 'x') {
        const cx = Math.floor(x);
        const clamped = nx > x ? cx + 1 - PLAYER_RADIUS - 1e-4 : cx + PLAYER_RADIUS + 1e-4;
        if (this.canOccupy(clamped, ny)) {
          x = clamped;
          y = ny;
        }
      } else {
        const cy = Math.floor(y);
        const clamped = ny > y ? cy + 1 - PLAYER_RADIUS - 1e-4 : cy + PLAYER_RADIUS + 1e-4;
        if (this.canOccupy(nx, clamped)) {
          x = nx;
          y = clamped;
        }
      }
    };

    tryAxis(x + dx, y, 'x');
    tryAxis(x, y + dy, 'y');
    return { x, y };
  }

  /**
   * Whether a player disc at (x, y) fits: each corner of its bounding square
   * must be reachable from the center cell through open edges only.
   */
  private canOccupy(x: number, y: number): boolean {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    for (const ox of [-PLAYER_RADIUS, PLAYER_RADIUS]) {
      for (const oy of [-PLAYER_RADIUS, PLAYER_RADIUS]) {
        const ccx = Math.floor(x + ox);
        const ccy = Math.floor(y + oy);
        if (ccx === cx && ccy === cy) {
          continue;
        }
        const dirX: Direction | null = ccx > cx ? 'east' : ccx < cx ? 'west' : null;
        const dirY: Direction | null = ccy > cy ? 'south' : ccy < cy ? 'north' : null;
        if (dirX && !dirY) {
          if (!this.generator.isPassable(cx, cy, dirX)) {
            return false;
          }
        } else if (dirY && !dirX) {
          if (!this.generator.isPassable(cx, cy, dirY)) {
            return false;
          }
        } else if (dirX && dirY) {
          const viaX =
            this.generator.isPassable(cx, cy, dirX) && this.generator.isPassable(ccx, cy, dirY);
          const viaY =
            this.generator.isPassable(cx, cy, dirY) && this.generator.isPassable(cx, ccy, dirX);
          if (!viaX && !viaY) {
            return false;
          }
        }
      }
    }
    return true;
  }

  // --- Lights ----------------------------------------------------------------

  private lightState(cx: number, cy: number): LightState | null {
    const mod = (n: number, m: number): number => ((n % m) + m) % m;
    if (mod(cx, LIGHT_LATTICE) !== 1 || mod(cy, LIGHT_LATTICE) !== 1) {
      return null;
    }
    const u = unitFromHash(hashCoords(this.seed, cx, cy, SALT.lightState));
    if (u < 0.12) {
      return 'dead';
    }
    if (u < 0.2) {
      return 'flicker';
    }
    return 'on';
  }

  /** Summed light contribution at a plane point, in [0, 1]. */
  private lightLevelAt(x: number, y: number): number {
    const reach = 3.2;
    let level = 0;
    const minGx = Math.floor((x - reach) / LIGHT_LATTICE);
    const maxGx = Math.floor((x + reach) / LIGHT_LATTICE);
    const minGy = Math.floor((y - reach) / LIGHT_LATTICE);
    const maxGy = Math.floor((y + reach) / LIGHT_LATTICE);
    for (let gy = minGy; gy <= maxGy; gy++) {
      for (let gx = minGx; gx <= maxGx; gx++) {
        const lcx = gx * LIGHT_LATTICE + 1;
        const lcy = gy * LIGHT_LATTICE + 1;
        const state = this.lightState(lcx, lcy);
        if (state !== 'on' && state !== 'flicker') {
          continue;
        }
        const dx = x - (lcx + 0.5);
        const dy = y - (lcy + 0.5);
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < reach) {
          const fall = 1 - d / reach;
          level += fall * fall * (state === 'flicker' ? 0.55 : 1);
        }
      }
    }
    return Math.min(1, level);
  }

  // --- Wallpaper zones -------------------------------------------------------

  /**
   * Random enclosed shapes: anchors on a coarse lattice each spawn a wobbled
   * closed radial blob (radius modulated by two sine harmonics with hashed
   * phases). A cell inside a blob adopts that zone's palette; the innermost
   * blob wins where blobs overlap.
   */
  zoneAt(cx: number, cy: number): Zone | null {
    if (!this.wallpaperShiftsEnabled) {
      return null;
    }
    const key = `${cx},${cy}`;
    const cached = this.zoneCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (this.zoneCache.size > 20000) {
      this.zoneCache.clear();
    }

    const gx0 = Math.floor(cx / ZONE_LATTICE);
    const gy0 = Math.floor(cy / ZONE_LATTICE);
    let best: { depth: number; zone: Zone } | null = null;
    for (let gy = gy0 - 1; gy <= gy0 + 1; gy++) {
      for (let gx = gx0 - 1; gx <= gx0 + 1; gx++) {
        const draw = (salt: number): number => unitFromHash(hashCoords(this.seed, gx, gy, salt));
        if (draw(SALT.zoneAnchor) >= 0.45) {
          continue;
        }
        const centerX = (gx + draw(SALT.zoneCenterX)) * ZONE_LATTICE;
        const centerY = (gy + draw(SALT.zoneCenterY)) * ZONE_LATTICE;
        const base = 3 + draw(SALT.zoneRadius) * 5;
        const dx = cx + 0.5 - centerX;
        const dy = cy + 0.5 - centerY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const theta = Math.atan2(dy, dx);
        const p1 = draw(SALT.zonePhase1) * Math.PI * 2;
        const p2 = draw(SALT.zonePhase2) * Math.PI * 2;
        const radius = base * (1 + 0.3 * Math.sin(3 * theta + p1) + 0.18 * Math.sin(5 * theta + p2));
        if (dist >= radius) {
          continue;
        }
        const depth = dist / radius;
        if (!best || depth < best.depth) {
          const palette = ZONE_PALETTES[Math.floor(draw(SALT.zonePalette) * ZONE_PALETTES.length)] ?? WHITE;
          best = {
            depth,
            zone: { tint: [...palette] as [number, number, number], variant: draw(SALT.zoneVariant) < 0.5 },
          };
        }
      }
    }
    const zone = best?.zone ?? null;
    this.zoneCache.set(key, zone);
    return zone;
  }

  // --- Chunk streaming -------------------------------------------------------

  /**
   * Ensures every chunk within the render distance is meshed and uploaded,
   * dropping chunks that fell out of range. Returns the drawable set.
   */
  updateChunks(px: number, py: number, renderDistance: number, renderer: Renderer): Iterable<ChunkMesh> {
    const range = renderDistance + CHUNK_SIZE;
    const minCx = Math.floor((px - range) / CHUNK_SIZE);
    const maxCx = Math.floor((px + range) / CHUNK_SIZE);
    const minCy = Math.floor((py - range) / CHUNK_SIZE);
    const maxCy = Math.floor((py + range) / CHUNK_SIZE);

    const wanted = new Set<string>();
    for (let gy = minCy; gy <= maxCy; gy++) {
      for (let gx = minCx; gx <= maxCx; gx++) {
        const centerX = (gx + 0.5) * CHUNK_SIZE;
        const centerY = (gy + 0.5) * CHUNK_SIZE;
        const dist = Math.hypot(centerX - px, centerY - py);
        if (dist > renderDistance + CHUNK_SIZE) {
          continue;
        }
        const key = `${gx},${gy}`;
        wanted.add(key);
        if (!this.chunks.has(key)) {
          this.chunks.set(key, this.buildChunk(gx, gy, renderer));
        }
      }
    }
    for (const [key, mesh] of this.chunks) {
      if (!wanted.has(key)) {
        renderer.disposeChunk(mesh);
        this.chunks.delete(key);
      }
    }
    return this.chunks.values();
  }

  /** Drops all uploaded chunks (e.g. when toggling furniture or zones). */
  invalidateChunks(renderer: Renderer): void {
    for (const mesh of this.chunks.values()) {
      renderer.disposeChunk(mesh);
    }
    this.chunks.clear();
    this.zoneCache.clear();
  }

  private buildChunk(gx: number, gy: number, renderer: Renderer): ChunkMesh {
    const builder = new MeshBuilder();
    for (let cy = gy * CHUNK_SIZE; cy < (gy + 1) * CHUNK_SIZE; cy++) {
      for (let cx = gx * CHUNK_SIZE; cx < (gx + 1) * CHUNK_SIZE; cx++) {
        this.emitCell(builder, this.generator.getCell(cx, cy));
      }
    }
    return renderer.uploadChunk(builder.vertices(), builder.indices());
  }

  private emitCell(b: MeshBuilder, cell: MazeCell): void {
    const { cx, cy } = cell;
    const x0 = cell.bounds.min.x;
    const y0 = cell.bounds.min.y;
    const x1 = cell.bounds.max.x;
    const y1 = cell.bounds.max.y;
    const h = cell.dimensions.depth;
    const zone = this.zoneAt(cx, cy);

    const shadeAt = (x: number, y: number, base: number, span: number): number =>
      base + span * this.lightLevelAt(x, y);

    // Floor: light yellow fiber carpet, faintly picking up the zone tint.
    const floorTint: [number, number, number] = zone
      ? [mix(1, zone.tint[0], 0.25), mix(1, zone.tint[1], 0.25), mix(1, zone.tint[2], 0.25)]
      : WHITE;
    b.quad(
      [x0, 0, y0], [x0, 0, y1], [x1, 0, y1], [x1, 0, y0],
      [x0, y0], [x0, y1], [x1, y1], [x1, y0],
      TILE.carpet,
      floorTint,
      [
        shadeAt(x0, y0, 0.5, 0.55), shadeAt(x0, y1, 0.5, 0.55),
        shadeAt(x1, y1, 0.5, 0.55), shadeAt(x1, y0, 0.5, 0.55),
      ],
    );

    // Ceiling: office tile pattern (two 0.5-unit tiles per cell edge).
    b.quad(
      [x0, h, y0], [x1, h, y0], [x1, h, y1], [x0, h, y1],
      [x0 * 2, y0 * 2], [x1 * 2, y0 * 2], [x1 * 2, y1 * 2], [x0 * 2, y1 * 2],
      TILE.ceiling,
      WHITE,
      [
        shadeAt(x0, y0, 0.38, 0.4), shadeAt(x1, y0, 0.38, 0.4),
        shadeAt(x1, y1, 0.38, 0.4), shadeAt(x0, y1, 0.38, 0.4),
      ],
    );

    // Light panel: light-yellow opaque plastic hung just below the ceiling.
    const light = this.lightState(cx, cy);
    if (light) {
      const inset = 0.24;
      const drop = 0.02;
      const lx0 = x0 + inset;
      const lx1 = x1 - inset;
      const ly0 = y0 + inset;
      const ly1 = y1 - inset;
      const py = h - drop;
      const shade = light === 'dead' ? 0.32 : light === 'flicker' ? EMISSIVE_SHADE + 0.35 : EMISSIVE_SHADE + 0.6;
      b.quad(
        [lx0, py, ly0], [lx1, py, ly0], [lx1, py, ly1], [lx0, py, ly1],
        [0, 0], [1, 0], [1, 1], [0, 1],
        TILE.lightPanel,
        WHITE,
        [shade, shade, shade, shade],
      );
    }

    // Walls: extrude each solid edge into a slab with visible depth; open
    // edges may carry a doorway header instead.
    for (const direction of DIRECTIONS) {
      if (cell.edges[direction].solid) {
        this.emitWallSlab(b, cell, direction, zone);
      } else {
        this.emitDoorHeader(b, cell, direction, zone);
      }
    }

    // Interior props: columns and random furniture.
    if (cell.feature && this.furnitureEnabled) {
      this.emitFeature(b, cell, cell.feature);
    }
  }

  /** Resolves the tile, tint, and wear factor for one wall edge. */
  private wallMaterial(edge: MazeEdge, zone: Zone | null): {
    tile: number;
    tint: [number, number, number];
    wear: number;
  } {
    let tile: number;
    if (this.wallOverrideTile !== null) {
      tile = this.wallOverrideTile;
    } else if (this.uniformWallpaper) {
      tile = TILE.wallpaperA;
    } else {
      tile = WALL_TILE_BY_SURFACE[edge.metadata.surfaceType];
    }
    let tint = this.wallBaseTint;
    // Wallpaper zones recolor walls; on non-classic presets the shift reads
    // as a different dye lot of the same material.
    if (zone && (this.wallOverrideTile !== null || tile === TILE.wallpaperA)) {
      tint = [tint[0] * zone.tint[0], tint[1] * zone.tint[1], tint[2] * zone.tint[2]];
      if (zone.variant && tile === TILE.wallpaperA) {
        tile = TILE.wallpaperB;
      }
    }
    // Stable per-edge brightness variation from the material seed.
    const wear = 0.92 + unitFromHash(edge.metadata.materialSeed) * 0.12;
    return { tile, tint, wear };
  }

  /**
   * A solid edge as a slab: the inward face is inset by WALL_HALF_DEPTH (the
   * neighbor emits the matching opposite face), and any end where the wall
   * line stops at an open passage gets a jamb cap sealing the slab depth.
   */
  private emitWallSlab(b: MeshBuilder, cell: MazeCell, direction: Direction, zone: Zone | null): void {
    const h = cell.dimensions.depth;
    this.emitWallFace(b, cell, direction, 0, h, zone);

    const edge = cell.edges[direction];
    const inward = step(opposite(direction));
    const mat = this.wallMaterial(edge, zone);
    for (const end of [edge.start, edge.end]) {
      const other = end === edge.start ? edge.end : edge.start;
      const ox = Math.sign(end.x - other.x);
      const oy = Math.sign(end.y - other.y);
      // The wall line continues into the neighbor along the line; only an
      // open continuation edge exposes this end as a doorway jamb.
      if (this.generator.isPassable(cell.cx + ox, cell.cy + oy, direction)) {
        this.emitJamb(b, end, { ox, oy }, inward, 0, h, mat);
      }
    }
  }

  /**
   * A vertical cap strip sealing this cell's half of a wall slab at a wall
   * end, facing out of the wall along `out`.
   */
  private emitJamb(
    b: MeshBuilder,
    at: Vec2,
    out: { ox: number; oy: number },
    inward: { dx: number; dy: number },
    yBottom: number,
    yTop: number,
    mat: { tile: number; tint: [number, number, number]; wear: number },
  ): void {
    let ax = at.x;
    let az = at.y;
    let bx = at.x + inward.dx * WALL_HALF_DEPTH;
    let bz = at.y + inward.dy * WALL_HALF_DEPTH;
    // Winding: normal of the (a -> b) strip is (-(bz-az), bx-ax); flip so it
    // points along `out`, into the passage.
    if (-(bz - az) * out.ox + (bx - ax) * out.oy < 0) {
      [ax, bx] = [bx, ax];
      [az, bz] = [bz, az];
    }
    const shade = (0.42 + 0.5 * this.lightLevelAt(at.x + out.ox * 0.2, at.y + out.oy * 0.2)) * mat.wear * 0.82;
    const u0 = ax + az;
    const u1 = bx + bz;
    b.quad(
      [ax, yBottom, az], [bx, yBottom, bz], [bx, yTop, bz], [ax, yTop, az],
      [u0, yBottom / 1.6], [u1, yBottom / 1.6], [u1, yTop / 1.6], [u0, yTop / 1.6],
      mat.tile,
      mat.tint,
      [shade, shade, shade * 0.92, shade * 0.92],
    );
  }

  /**
   * Header over an open edge. An opening whose wall line is solid on both
   * flanks reads as a doorway punched through a wall, so it gets a lintel:
   * face down to DOOR_TOP_FRACTION of the lower ceiling, a soffit underside,
   * and end caps. Interior edges of merged open areas (room/hall/atrium
   * pairs) only get a soffit band where the neighbor's ceiling steps down.
   */
  private emitDoorHeader(b: MeshBuilder, cell: MazeCell, direction: Direction, zone: Zone | null): void {
    const h = cell.dimensions.depth;
    const { dx, dy } = step(direction);
    const ncx = cell.cx + dx;
    const ncy = cell.cy + dy;
    const nh = this.generator.getCell(ncx, ncy).dimensions.depth;

    const gen = this.generator;
    const interior =
      (gen.isRoom(cell.cx, cell.cy) && gen.isRoom(ncx, ncy)) ||
      (gen.isHall(cell.cx, cell.cy) && gen.isHall(ncx, ncy)) ||
      (gen.isAtrium(cell.cx, cell.cy) && gen.isAtrium(ncx, ncy));

    let bottom: number | null = null;
    if (!interior) {
      const edge = cell.edges[direction];
      const flanks = [edge.start, edge.end].map((end) => {
        const other = end === edge.start ? edge.end : edge.start;
        const ox = Math.sign(end.x - other.x);
        const oy = Math.sign(end.y - other.y);
        return !gen.isPassable(cell.cx + ox, cell.cy + oy, direction);
      });
      if (flanks[0] && flanks[1]) {
        bottom = Math.min(h, nh) * DOOR_TOP_FRACTION;
      }
    }
    if (bottom === null && nh < h - 0.01) {
      // Ceiling steps down across the passage: band from the lower ceiling.
      bottom = nh;
    }
    if (bottom === null || bottom >= h - 0.005) {
      return;
    }

    this.emitWallFace(b, cell, direction, bottom, h, zone);

    const edge = cell.edges[direction];
    const inward = step(opposite(direction));
    const mat = this.wallMaterial(edge, zone);
    const T = WALL_HALF_DEPTH;

    // Soffit: the header's underside, from the boundary line to the inset
    // face, visible from below.
    let sx = edge.start.x;
    let sz = edge.start.y;
    let ex = edge.end.x;
    let ez = edge.end.y;
    // Winding for a downward normal: cross(e - s, inward).y must be negative.
    if ((ez - sz) * inward.dx - (ex - sx) * inward.dy > 0) {
      [sx, ex] = [ex, sx];
      [sz, ez] = [ez, sz];
    }
    const soffitShade = (0.36 + 0.4 * this.lightLevelAt((sx + ex) / 2, (sz + ez) / 2)) * mat.wear;
    b.quad(
      [sx, bottom, sz],
      [ex, bottom, ez],
      [ex + inward.dx * T, bottom, ez + inward.dy * T],
      [sx + inward.dx * T, bottom, sz + inward.dy * T],
      [sx + sz, 0], [ex + ez, 0], [ex + ez, T / 1.6], [sx + sz, T / 1.6],
      mat.tile,
      mat.tint,
      [soffitShade, soffitShade, soffitShade, soffitShade],
    );

    // Seal both header ends so no hollow slab interior is ever visible.
    for (const end of [edge.start, edge.end]) {
      const other = end === edge.start ? edge.end : edge.start;
      const ox = Math.sign(end.x - other.x);
      const oy = Math.sign(end.y - other.y);
      this.emitJamb(b, end, { ox, oy }, inward, bottom, h, mat);
    }
  }

  /**
   * The inward-facing wall face for an edge, inset WALL_HALF_DEPTH into the
   * cell so the slab has visible extrusion depth at openings.
   */
  private emitWallFace(
    b: MeshBuilder,
    cell: MazeCell,
    direction: Direction,
    yBottom: number,
    yTop: number,
    zone: Zone | null,
  ): void {
    const edge = cell.edges[direction];
    const inward = step(opposite(direction));
    const T = WALL_HALF_DEPTH;
    let sx = edge.start.x + inward.dx * T;
    let sz = edge.start.y + inward.dy * T;
    let ex = edge.end.x + inward.dx * T;
    let ez = edge.end.y + inward.dy * T;

    // Order the segment so the face normal points into the cell (backface
    // culling hides the outside; the neighbor emits its own facing copy).
    const normalX = -(ez - sz);
    const normalZ = ex - sx;
    if (normalX * inward.dx + normalZ * inward.dy < 0) {
      [sx, ex] = [ex, sx];
      [sz, ez] = [ez, sz];
    }

    const { tile, tint, wear } = this.wallMaterial(edge, zone);
    const u0 = sx + sz;
    const u1 = ex + ez;
    const v0 = yBottom / 1.6;
    const v1 = yTop / 1.6;
    const sample = (x: number, z: number): number =>
      (0.42 + 0.5 * this.lightLevelAt(x, z)) * wear;
    const sS = sample(sx + inward.dx * 0.2, sz + inward.dy * 0.2);
    const sE = sample(ex + inward.dx * 0.2, ez + inward.dy * 0.2);

    b.quad(
      [sx, yBottom, sz], [ex, yBottom, ez], [ex, yTop, ez], [sx, yTop, sz],
      [u0, v0], [u1, v0], [u1, v1], [u0, v1],
      tile,
      tint,
      [sS, sE, sE * 0.92, sS * 0.92],
    );
  }

  private emitFeature(b: MeshBuilder, cell: MazeCell, feature: CellFeature): void {
    const fx = feature.position.x;
    const fz = feature.position.y;
    const h = cell.dimensions.depth;
    const light = 0.4 + 0.5 * this.lightLevelAt(fx, fz);

    if (feature.kind === 'column') {
      const r = Math.max(0.09, feature.size);
      emitBox(b, fx - r, fx + r, 0, h, fz - r, fz + r, TILE.drywall, WHITE, light);
      return;
    }

    // Random furniture: archetype chosen from the feature's stable seed.
    const rng = mulberry32(feature.variantSeed);
    const scale = clamp(feature.size / 0.15, 0.75, 1.35);
    const archetype = Math.floor(rng.next() * 4);
    const s = (v: number): number => v * scale;

    switch (archetype) {
      case 0: {
        // Filing cabinet.
        emitBox(b, fx - s(0.14), fx + s(0.14), 0, s(0.52), fz - s(0.12), fz + s(0.12), TILE.metal, WHITE, light);
        break;
      }
      case 1: {
        // Desk: two side slabs carrying a wooden top.
        const w = s(0.32);
        const d = s(0.2);
        const top = s(0.3);
        emitBox(b, fx - w, fx - w + s(0.04), 0, top, fz - d, fz + d, TILE.wood, WHITE, light * 0.9);
        emitBox(b, fx + w - s(0.04), fx + w, 0, top, fz - d, fz + d, TILE.wood, WHITE, light * 0.9);
        emitBox(b, fx - w, fx + w, top, top + s(0.04), fz - d, fz + d, TILE.wood, WHITE, light);
        break;
      }
      case 2: {
        // Couch: seat base plus a back rest.
        const w = s(0.36);
        const d = s(0.17);
        emitBox(b, fx - w, fx + w, 0, s(0.18), fz - d, fz + d, TILE.fabric, WHITE, light);
        emitBox(b, fx - w, fx + w, s(0.18), s(0.4), fz + d - s(0.07), fz + d, TILE.fabric, WHITE, light * 0.95);
        break;
      }
      default: {
        // Stack of moving boxes.
        const r = s(0.17);
        emitBox(b, fx - r, fx + r, 0, s(0.26), fz - r, fz + r, TILE.cardboard, WHITE, light);
        const r2 = s(0.12);
        const ox = (rng.next() - 0.5) * s(0.08);
        const oz = (rng.next() - 0.5) * s(0.08);
        emitBox(b, fx - r2 + ox, fx + r2 + ox, s(0.26), s(0.46), fz - r2 + oz, fz + r2 + oz, TILE.cardboard, WHITE, light * 1.05);
        break;
      }
    }
  }

}

/** Emits an axis-aligned box: four outward walls plus a top (no bottom). */
export function emitBox(
  b: MeshBuilder,
  x0: number, x1: number,
  y0: number, y1: number,
  z0: number, z1: number,
  tile: number,
  tint: [number, number, number],
  shade: number,
): void {
    const sides = shade * 0.85;
    const uw = (x1 - x0) * 2;
    const ud = (z1 - z0) * 2;
    const vh = (y1 - y0) * 2;
    // South face (+Z), north face (-Z), east (+X), west (-X): all CCW from outside.
    b.quad(
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
      [0, 0], [uw, 0], [uw, vh], [0, vh], tile, tint, [sides, sides, sides, sides],
    );
    b.quad(
      [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0],
      [0, 0], [uw, 0], [uw, vh], [0, vh], tile, tint, [sides, sides, sides, sides],
    );
    b.quad(
      [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1],
      [0, 0], [ud, 0], [ud, vh], [0, vh], tile, tint, [sides, sides, sides, sides],
    );
    b.quad(
      [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0],
      [0, 0], [ud, 0], [ud, vh], [0, vh], tile, tint, [sides, sides, sides, sides],
    );
    b.quad(
      [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0],
      [0, 0], [0, ud], [uw, ud], [uw, 0], tile, tint, [shade, shade, shade, shade],
  );
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Rotates an RGB triple around the hue wheel (same math as CSS hue-rotate). */
function hueRotate(rgb: readonly [number, number, number], degrees: number): [number, number, number] {
  const rad = (degrees * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const [r, g, b] = rgb;
  return [
    (0.213 + c * 0.787 - s * 0.213) * r + (0.715 - c * 0.715 - s * 0.715) * g + (0.072 - c * 0.072 + s * 0.928) * b,
    (0.213 - c * 0.213 + s * 0.143) * r + (0.715 + c * 0.285 + s * 0.14) * g + (0.072 - c * 0.072 - s * 0.283) * b,
    (0.213 - c * 0.213 - s * 0.787) * r + (0.715 - c * 0.715 + s * 0.715) * g + (0.072 + c * 0.928 + s * 0.072) * b,
  ];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export type Vec3 = [number, number, number];
type Uv = [number, number];

/** Accumulates interleaved vertices and triangle indices for one mesh. */
export class MeshBuilder {
  private readonly verts: number[] = [];
  private readonly idx: number[] = [];
  private count = 0;

  quad(
    p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3,
    t0: Uv, t1: Uv, t2: Uv, t3: Uv,
    tile: number,
    tint: [number, number, number],
    shades: [number, number, number, number],
  ): void {
    const points = [p0, p1, p2, p3];
    const uvs = [t0, t1, t2, t3];
    for (let i = 0; i < 4; i++) {
      const p = points[i]!;
      const t = uvs[i]!;
      this.verts.push(p[0], p[1], p[2], t[0], t[1], tile, tint[0], tint[1], tint[2], shades[i]!);
    }
    const base = this.count;
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    this.count += 4;
  }

  vertices(): Float32Array {
    return new Float32Array(this.verts);
  }

  indices(): Uint16Array {
    if (this.count > 0xffff) {
      throw new Error(`Chunk exceeds 16-bit index range: ${this.count} vertices`);
    }
    return new Uint16Array(this.idx);
  }
}
