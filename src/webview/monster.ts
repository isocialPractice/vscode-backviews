/**
 * The other thing in the halls. Dormant until a randomized time inside the
 * configured spawn window, then it appears some corridors away and stalks the
 * player through open edges only (it obeys the same walls the player does,
 * via the generator's isPassable test). Touching the player ends the take.
 *
 * Rendering is a small world-space mesh rebuilt every frame into the
 * renderer's dynamic buffer: dark silhouette geometry plus two emissive eyes
 * that always face the player.
 */
import { DIRECTIONS, step } from 'cmd-backedges';
import { MonsterForm } from '../shared/settings';
import { EMISSIVE_SHADE } from './renderer';
import { TILE } from './textures';
import { emitBox, MeshBuilder, Vec3, World } from './world';

export interface MonsterConfig {
  /** Cells per second while stalking. */
  speed: number;
  /** Earliest spawn, in milliseconds after arming. */
  spawnMinMs: number;
  /** Latest spawn, in milliseconds after arming. */
  spawnMaxMs: number;
  /** Body plan; `random` rolls one per spawn. */
  form: MonsterForm;
}

export type MonsterEvent = 'spawned' | 'caught' | null;

type BodyForm = Exclude<MonsterForm, 'random'>;

const BODY_FORMS: readonly BodyForm[] = ['spider', 'humanoid', 'cloud'];
const CATCH_DISTANCE = 0.45;
const REPATH_MS = 600;
const PATH_NODE_CAP = 900;

const DARK: [number, number, number] = [1, 1, 1];
const BODY_SHADE = 0.16;
const EYE_TINT: [number, number, number] = [1, 0.16, 0.1];

export class Monster {
  form: BodyForm = 'spider';
  x = 0;
  y = 0;

  private config: MonsterConfig;
  private stalking = false;
  private spawnAt = 0;
  private path: { cx: number; cy: number }[] = [];
  private lastPathAt = 0;
  private phase = 0;
  private heading = 0;

  constructor(private readonly world: World, config: MonsterConfig, now: number) {
    this.config = config;
    this.arm(now);
  }

  get isStalking(): boolean {
    return this.stalking;
  }

  /** Applies new tuning live; the spawn window only affects future arms. */
  configure(config: MonsterConfig): void {
    const formChanged = config.form !== this.config.form;
    this.config = config;
    if (formChanged && config.form !== 'random') {
      this.form = config.form;
    }
  }

  /** Returns to dormant and schedules the next appearance. */
  arm(now: number): void {
    this.stalking = false;
    this.path = [];
    const min = Math.min(this.config.spawnMinMs, this.config.spawnMaxMs);
    const max = Math.max(this.config.spawnMinMs, this.config.spawnMaxMs);
    this.spawnAt = now + min + Math.random() * (max - min);
  }

  update(now: number, dt: number, px: number, py: number): MonsterEvent {
    if (!this.stalking) {
      if (now >= this.spawnAt) {
        this.spawn(px, py);
        return 'spawned';
      }
      return null;
    }

    const distToPlayer = Math.hypot(px - this.x, py - this.y);
    if (distToPlayer < CATCH_DISTANCE) {
      this.arm(now);
      return 'caught';
    }

    if (now - this.lastPathAt > REPATH_MS) {
      this.lastPathAt = now;
      this.path = this.findPath(Math.floor(this.x), Math.floor(this.y), Math.floor(px), Math.floor(py));
    }

    // Head for the next waypoint center; fall back to a greedy open edge.
    let target = this.path[0] ? center(this.path[0]) : this.greedyStep(px, py);
    // Close enough to see the player's cell: cut straight toward them.
    if (this.path.length <= 1 && distToPlayer < 1.4) {
      target = { x: px, y: py };
    }
    const dx = target.x - this.x;
    const dy = target.y - this.y;
    const dist = Math.hypot(dx, dy);
    const travel = this.config.speed * dt;
    if (dist > 1e-4) {
      const t = Math.min(1, travel / dist);
      this.x += dx * t;
      this.y += dy * t;
      this.heading = Math.atan2(dy, dx);
      this.phase += travel * 4.4;
    }
    if (this.path[0] && Math.hypot(center(this.path[0]).x - this.x, center(this.path[0]).y - this.y) < 0.08) {
      this.path.shift();
    }
    return null;
  }

  private spawn(px: number, py: number): void {
    if (this.config.form === 'random') {
      this.form = BODY_FORMS[Math.floor(Math.random() * BODY_FORMS.length)]!;
    } else {
      this.form = this.config.form;
    }
    // Appear 9 to 14 cells out, beyond the fog at default render distance.
    const angle = Math.random() * Math.PI * 2;
    const dist = 9 + Math.random() * 5;
    this.x = Math.floor(px + Math.cos(angle) * dist) + 0.5;
    this.y = Math.floor(py + Math.sin(angle) * dist) + 0.5;
    this.path = [];
    this.lastPathAt = 0;
    this.stalking = true;
  }

  /** Breadth-first search through open edges, capped for the infinite grid. */
  private findPath(fromCx: number, fromCy: number, toCx: number, toCy: number): { cx: number; cy: number }[] {
    if (fromCx === toCx && fromCy === toCy) {
      return [];
    }
    const key = (cx: number, cy: number): string => `${cx},${cy}`;
    const parents = new Map<string, string | null>();
    parents.set(key(fromCx, fromCy), null);
    const queue: { cx: number; cy: number }[] = [{ cx: fromCx, cy: fromCy }];
    let found = false;
    while (queue.length > 0 && parents.size < PATH_NODE_CAP) {
      const node = queue.shift()!;
      if (node.cx === toCx && node.cy === toCy) {
        found = true;
        break;
      }
      for (const direction of DIRECTIONS) {
        if (!this.world.generator.isPassable(node.cx, node.cy, direction)) {
          continue;
        }
        const { dx, dy } = step(direction);
        const next = { cx: node.cx + dx, cy: node.cy + dy };
        const nextKey = key(next.cx, next.cy);
        if (!parents.has(nextKey)) {
          parents.set(nextKey, key(node.cx, node.cy));
          queue.push(next);
        }
      }
    }
    if (!found) {
      return [];
    }
    const path: { cx: number; cy: number }[] = [];
    let cursor: string | null = key(toCx, toCy);
    while (cursor && cursor !== key(fromCx, fromCy)) {
      const [cx, cy] = cursor.split(',').map(Number) as [number, number];
      path.unshift({ cx, cy });
      cursor = parents.get(cursor) ?? null;
    }
    return path;
  }

  /** No path known: shuffle toward the player through any open edge. */
  private greedyStep(px: number, py: number): { x: number; y: number } {
    const cx = Math.floor(this.x);
    const cy = Math.floor(this.y);
    let best: { x: number; y: number } = { x: this.x, y: this.y };
    let bestDist = Number.POSITIVE_INFINITY;
    for (const direction of DIRECTIONS) {
      if (!this.world.generator.isPassable(cx, cy, direction)) {
        continue;
      }
      const { dx, dy } = step(direction);
      const candidate = center({ cx: cx + dx, cy: cy + dy });
      const dist = Math.hypot(px - candidate.x, py - candidate.y);
      if (dist < bestDist) {
        bestDist = dist;
        best = candidate;
      }
    }
    return best;
  }

  /** Emits this frame's world-space geometry. */
  buildMesh(now: number, px: number, py: number): { vertices: Float32Array; indices: Uint16Array } {
    const b = new MeshBuilder();
    switch (this.form) {
      case 'spider':
        this.buildSpider(b);
        break;
      case 'humanoid':
        this.buildHumanoid(b);
        break;
      case 'cloud':
        this.buildCloud(b, now);
        break;
    }
    this.buildEyes(b, px, py);
    return { vertices: b.vertices(), indices: b.indices() };
  }

  private buildSpider(b: MeshBuilder): void {
    const { x, y } = this;
    emitBox(b, x - 0.19, x + 0.19, 0.2, 0.42, y - 0.23, y + 0.23, TILE.fabric, DARK, BODY_SHADE);
    emitBox(b, x - 0.09, x + 0.09, 0.26, 0.4, y - 0.34, y - 0.2, TILE.fabric, DARK, BODY_SHADE * 1.2);
    for (let i = 0; i < 8; i++) {
      const side = i < 4 ? -1 : 1;
      const spread = ((i % 4) - 1.5) * 0.5 + this.heading;
      const lift = Math.max(0, Math.sin(this.phase + i * (Math.PI / 2))) * 0.1;
      const hip: Vec3 = [x + side * 0.17, 0.34, y + Math.sin(spread) * 0.15];
      const foot: Vec3 = [
        x + side * (0.5 + 0.1 * Math.sin(i * 2.1)),
        lift,
        y + Math.sin(spread) * 0.42 + Math.cos(spread) * side * 0.12,
      ];
      this.limb(b, hip, foot, 0.045);
    }
  }

  private buildHumanoid(b: MeshBuilder): void {
    const { x, y } = this;
    const sway = Math.sin(this.phase * 0.5) * 0.03;
    emitBox(b, x - 0.11 + sway, x + 0.11 + sway, 0.52, 1.06, y - 0.07, y + 0.07, TILE.fabric, DARK, BODY_SHADE);
    emitBox(b, x - 0.06 + sway, x + 0.06 + sway, 1.06, 1.2, y - 0.06, y + 0.06, TILE.fabric, DARK, BODY_SHADE * 1.15);
    const strideX = Math.cos(this.heading) * 0.16;
    const strideY = Math.sin(this.heading) * 0.16;
    const gait = Math.sin(this.phase);
    // Legs scissor along the heading; arms hang and counter-swing.
    this.limb(b, [x - 0.06, 0.55, y], [x - 0.06 + strideX * gait, 0, y + strideY * gait], 0.05);
    this.limb(b, [x + 0.06, 0.55, y], [x + 0.06 - strideX * gait, 0, y - strideY * gait], 0.05);
    this.limb(b, [x - 0.13 + sway, 1.0, y], [x - 0.13 + sway - strideX * gait * 0.5, 0.5, y - strideY * gait * 0.5], 0.04);
    this.limb(b, [x + 0.13 + sway, 1.0, y], [x + 0.13 + sway + strideX * gait * 0.5, 0.5, y + strideY * gait * 0.5], 0.04);
  }

  private buildCloud(b: MeshBuilder, now: number): void {
    const { x, y } = this;
    const t = now / 1000;
    for (let i = 0; i < 10; i++) {
      const jx = Math.sin(t * 1.3 + i * 2.4) * 0.14;
      const jy = Math.sin(t * 1.7 + i * 1.9) * 0.1;
      const jz = Math.cos(t * 1.1 + i * 3.2) * 0.14;
      const size = 0.12 + ((i * 37) % 10) * 0.02;
      const cx = x + Math.sin(i * 2.4) * 0.2 + jx;
      const cy = 0.45 + Math.sin(i * 1.6) * 0.3 + jy;
      const cz = y + Math.cos(i * 2.9) * 0.2 + jz;
      emitBox(b, cx - size, cx + size, cy - size, cy + size, cz - size, cz + size, TILE.concrete, DARK, BODY_SHADE * (0.8 + (i % 3) * 0.2));
    }
  }

  /** Two small emissive eyes billboarded toward the player. */
  private buildEyes(b: MeshBuilder, px: number, py: number): void {
    const eyeHeight = this.form === 'spider' ? 0.36 : this.form === 'humanoid' ? 1.13 : 0.7;
    const toPlayerX = px - this.x;
    const toPlayerY = py - this.y;
    const len = Math.hypot(toPlayerX, toPlayerY) || 1;
    const fx = toPlayerX / len;
    const fy = toPlayerY / len;
    // Perpendicular in the plane; eyes sit slightly toward the player.
    const rx = -fy;
    const ry = fx;
    const ex = this.x + fx * 0.2;
    const ey = this.y + fy * 0.2;
    const r = 0.03;
    for (const side of [-1, 1]) {
      const cx = ex + rx * side * 0.06;
      const cy = ey + ry * side * 0.06;
      b.quad(
        [cx - rx * r, eyeHeight - r, cy - ry * r],
        [cx + rx * r, eyeHeight - r, cy + ry * r],
        [cx + rx * r, eyeHeight + r, cy + ry * r],
        [cx - rx * r, eyeHeight + r, cy - ry * r],
        [0, 0], [1, 0], [1, 1], [0, 1],
        TILE.lightPanel,
        EYE_TINT,
        [EMISSIVE_SHADE + 0.8, EMISSIVE_SHADE + 0.8, EMISSIVE_SHADE + 0.8, EMISSIVE_SHADE + 0.8],
      );
    }
  }

  /** A thin double-sided crossed-quad limb between two points. */
  private limb(b: MeshBuilder, from: Vec3, to: Vec3, width: number): void {
    const shades: [number, number, number, number] = [BODY_SHADE, BODY_SHADE, BODY_SHADE, BODY_SHADE];
    const uv: [[number, number], [number, number], [number, number], [number, number]] = [
      [0, 0], [1, 0], [1, 1], [0, 1],
    ];
    const planes: Vec3[] = [
      [width, 0, 0],
      [0, 0, width],
    ];
    for (const offset of planes) {
      const a0: Vec3 = [from[0] - offset[0], from[1] - offset[1], from[2] - offset[2]];
      const a1: Vec3 = [from[0] + offset[0], from[1] + offset[1], from[2] + offset[2]];
      const b1: Vec3 = [to[0] + offset[0], to[1] + offset[1], to[2] + offset[2]];
      const b0: Vec3 = [to[0] - offset[0], to[1] - offset[1], to[2] - offset[2]];
      b.quad(a0, a1, b1, b0, uv[0], uv[1], uv[2], uv[3], TILE.fabric, DARK, shades);
      b.quad(b0, b1, a1, a0, uv[0], uv[1], uv[2], uv[3], TILE.fabric, DARK, shades);
    }
  }
}

function center(cell: { cx: number; cy: number }): { x: number; y: number } {
  return { x: cell.cx + 0.5, y: cell.cy + 0.5 };
}
