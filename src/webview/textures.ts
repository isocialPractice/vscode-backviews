/**
 * Procedural texture atlas. Every material is painted onto one canvas at
 * startup (no image assets can be fetched under the webview CSP) and uploaded
 * as a single GL texture. Tiles repeat via fract() in the fragment shader, so
 * each tile keeps a half-texel inset to avoid atlas bleeding.
 */
import { mulberry32 } from 'cmd-backedges';

export const ATLAS_GRID = 4;
export const TILE_PX = 256;

/** Tile indices into the atlas; the shader derives UVs from these. */
export const TILE = {
  wallpaperA: 0,
  wallpaperB: 1,
  ceiling: 2,
  lightPanel: 3,
  carpet: 4,
  concrete: 5,
  paneling: 6,
  drywall: 7,
  ceramic: 8,
  fabric: 9,
  metal: 10,
  wood: 11,
  cardboard: 12,
} as const;

export type TileId = (typeof TILE)[keyof typeof TILE];

/** Photo textures that can replace procedural tiles at runtime. */
export interface MaterialImages {
  wallpaper?: HTMLImageElement;
  ceiling?: HTMLImageElement;
  carpet?: HTMLImageElement;
}

/**
 * Blits loaded material photos over their atlas tiles: wallpaper covers both
 * wallpaper variants (the zone variant gets a darkened copy so wallpaper
 * zones still read as a change), the ceiling photo gets the drop-ceiling
 * T-bar grid drawn back on top, and carpet replaces the floor tile.
 */
export function applyMaterialImages(canvas: HTMLCanvasElement, images: MaterialImages): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return;
  }
  const blit = (tile: number, image: HTMLImageElement, after?: (ctx: CanvasRenderingContext2D) => void): void => {
    const x = (tile % ATLAS_GRID) * TILE_PX;
    const y = Math.floor(tile / ATLAS_GRID) * TILE_PX;
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.rect(0, 0, TILE_PX, TILE_PX);
    ctx.clip();
    ctx.drawImage(image, 0, 0, TILE_PX, TILE_PX);
    after?.(ctx);
    ctx.restore();
  };

  if (images.wallpaper) {
    blit(TILE.wallpaperA, images.wallpaper);
    blit(TILE.wallpaperB, images.wallpaper, (c) => {
      c.fillStyle = 'rgba(96, 78, 30, 0.28)';
      c.fillRect(0, 0, TILE_PX, TILE_PX);
    });
  }
  if (images.ceiling) {
    blit(TILE.ceiling, images.ceiling, (c) => {
      c.strokeStyle = 'rgba(140, 134, 116, 0.85)';
      c.lineWidth = 3;
      for (let p = 0; p <= TILE_PX; p += TILE_PX / 2) {
        c.beginPath();
        c.moveTo(p, 0);
        c.lineTo(p, TILE_PX);
        c.moveTo(0, p);
        c.lineTo(TILE_PX, p);
        c.stroke();
      }
    });
  }
  if (images.carpet) {
    blit(TILE.carpet, images.carpet);
  }
}

export function buildAtlas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = ATLAS_GRID * TILE_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2D canvas context unavailable; cannot build texture atlas');
  }

  const painters: Record<number, (ctx: CanvasRenderingContext2D) => void> = {
    [TILE.wallpaperA]: paintWallpaperA,
    [TILE.wallpaperB]: paintWallpaperB,
    [TILE.ceiling]: paintCeiling,
    [TILE.lightPanel]: paintLightPanel,
    [TILE.carpet]: paintCarpet,
    [TILE.concrete]: paintConcrete,
    [TILE.paneling]: paintPaneling,
    [TILE.drywall]: paintDrywall,
    [TILE.ceramic]: paintCeramic,
    [TILE.fabric]: paintFabric,
    [TILE.metal]: paintMetal,
    [TILE.wood]: paintWood,
    [TILE.cardboard]: paintCardboard,
  };

  for (const [index, paint] of Object.entries(painters)) {
    const i = Number(index);
    const x = (i % ATLAS_GRID) * TILE_PX;
    const y = Math.floor(i / ATLAS_GRID) * TILE_PX;
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.rect(0, 0, TILE_PX, TILE_PX);
    ctx.clip();
    paint(ctx);
    ctx.restore();
  }
  return canvas;
}

/** Adds per-pixel brightness noise over the current tile area. */
function grain(ctx: CanvasRenderingContext2D, seed: number, amount: number): void {
  const image = ctx.getImageData(0, 0, TILE_PX, TILE_PX);
  const rng = mulberry32(seed);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const n = (rng.next() * 2 - 1) * amount;
    data[i] = clampByte(data[i]! + n);
    data[i + 1] = clampByte(data[i + 1]! + n);
    data[i + 2] = clampByte(data[i + 2]! + n);
  }
  // Repaint through the translated transform so the noise lands on this tile.
  const off = document.createElement('canvas');
  off.width = off.height = TILE_PX;
  off.getContext('2d')!.putImageData(image, 0, 0);
  ctx.drawImage(off, 0, 0);
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Low-alpha irregular blotches, used for water stains and wear. */
function stains(ctx: CanvasRenderingContext2D, seed: number, color: string, count: number): void {
  const rng = mulberry32(seed);
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const cx = rng.next() * TILE_PX;
    const cy = rng.next() * TILE_PX;
    const r = 12 + rng.next() * 46;
    ctx.globalAlpha = 0.04 + rng.next() * 0.07;
    ctx.beginPath();
    ctx.ellipse(cx, cy, r, r * (0.5 + rng.next() * 0.8), rng.next() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function paintWallpaperA(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#c9b765';
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
  ctx.fillStyle = '#b7a352';
  for (let x = 0; x < TILE_PX; x += 32) {
    ctx.fillRect(x, 0, 14, TILE_PX);
  }
  ctx.fillStyle = '#a3914a';
  for (let x = 0; x < TILE_PX; x += 32) {
    ctx.fillRect(x + 13, 0, 2, TILE_PX);
  }
  stains(ctx, 11, '#6f5f2c', 9);
  grain(ctx, 12, 7);
}

function paintWallpaperB(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#c4b268';
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
  ctx.fillStyle = '#ab984f';
  for (let y = 0; y < TILE_PX; y += 32) {
    for (let x = 0; x < TILE_PX; x += 32) {
      const ox = (Math.floor(y / 32) % 2) * 16;
      diamond(ctx, x + ox + 16, y + 16, 7);
    }
  }
  stains(ctx, 21, '#6f5f2c', 7);
  grain(ctx, 22, 6);
}

function diamond(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
  ctx.fill();
}

function paintCeiling(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#d8d3c2';
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
  // Classic office drop-ceiling: coarse tile grid with pinhole speckles.
  const rng = mulberry32(31);
  ctx.fillStyle = '#b9b4a1';
  for (let i = 0; i < 2600; i++) {
    ctx.fillRect(rng.next() * TILE_PX, rng.next() * TILE_PX, 1.5, 1.5);
  }
  ctx.strokeStyle = '#a09a87';
  ctx.lineWidth = 3;
  for (let p = 0; p <= TILE_PX; p += 128) {
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, TILE_PX);
    ctx.moveTo(0, p);
    ctx.lineTo(TILE_PX, p);
    ctx.stroke();
  }
  stains(ctx, 32, '#7c7452', 5);
  grain(ctx, 33, 5);
}

function paintLightPanel(ctx: CanvasRenderingContext2D): void {
  // Light yellow tinted opaque plastic diffuser, lit from behind.
  const g = ctx.createRadialGradient(128, 128, 20, 128, 128, 190);
  g.addColorStop(0, '#fefadd');
  g.addColorStop(0.7, '#f8eeb4');
  g.addColorStop(1, '#e4d78d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
  ctx.strokeStyle = 'rgba(190, 176, 110, 0.35)';
  ctx.lineWidth = 2;
  for (let p = 0; p <= TILE_PX; p += 32) {
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, TILE_PX);
    ctx.moveTo(0, p);
    ctx.lineTo(TILE_PX, p);
    ctx.stroke();
  }
  grain(ctx, 41, 3);
}

function paintCarpet(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#c2b47a';
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
  const rng = mulberry32(51);
  // Short fiber strokes in two directions read as cheap office carpet.
  for (let i = 0; i < 5200; i++) {
    const x = rng.next() * TILE_PX;
    const y = rng.next() * TILE_PX;
    const shade = 150 + Math.floor(rng.next() * 60);
    ctx.strokeStyle = `rgb(${shade}, ${shade - 14}, ${Math.floor(shade * 0.62)})`;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rng.next() * 4 - 2), y + (rng.next() * 4 - 2));
    ctx.stroke();
  }
  stains(ctx, 52, '#5d5228', 8);
  grain(ctx, 53, 6);
}

function paintConcrete(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#9a958a';
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
  const rng = mulberry32(61);
  ctx.strokeStyle = 'rgba(70, 66, 58, 0.5)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 5; i++) {
    let x = rng.next() * TILE_PX;
    let y = rng.next() * TILE_PX;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < 6; s++) {
      x += rng.next() * 40 - 20;
      y += rng.next() * 40 - 10;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  stains(ctx, 62, '#4c483e', 6);
  grain(ctx, 63, 10);
}

function paintPaneling(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#a8905e';
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
  const rng = mulberry32(71);
  for (let x = 0; x < TILE_PX; x += 42) {
    ctx.fillStyle = '#7d6741';
    ctx.fillRect(x, 0, 3, TILE_PX);
    for (let i = 0; i < 22; i++) {
      ctx.strokeStyle = `rgba(110, 88, 52, ${0.15 + rng.next() * 0.2})`;
      const gx = x + 5 + rng.next() * 34;
      ctx.beginPath();
      ctx.moveTo(gx, 0);
      ctx.bezierCurveTo(gx + 4, 80, gx - 4, 170, gx + 2, TILE_PX);
      ctx.stroke();
    }
  }
  grain(ctx, 72, 6);
}

function paintDrywall(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#cfc7ad';
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
  stains(ctx, 81, '#8d8465', 6);
  grain(ctx, 82, 6);
}

function paintCeramic(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#b8b2a0';
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
  ctx.fillStyle = '#d7d2c2';
  for (let y = 0; y < TILE_PX; y += 64) {
    for (let x = 0; x < TILE_PX; x += 64) {
      ctx.fillRect(x + 3, y + 3, 58, 58);
    }
  }
  stains(ctx, 91, '#6d6752', 5);
  grain(ctx, 92, 5);
}

function paintFabric(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#7a6f52';
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
  grain(ctx, 101, 12);
}

function paintMetal(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#8e9296';
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
  const rng = mulberry32(111);
  for (let x = 0; x < TILE_PX; x += 2) {
    ctx.fillStyle = `rgba(255, 255, 255, ${rng.next() * 0.06})`;
    ctx.fillRect(x, 0, 1, TILE_PX);
  }
  grain(ctx, 112, 5);
}

function paintWood(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#8b6b43';
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
  const rng = mulberry32(121);
  for (let i = 0; i < 30; i++) {
    ctx.strokeStyle = `rgba(70, 50, 26, ${0.15 + rng.next() * 0.25})`;
    const gy = rng.next() * TILE_PX;
    ctx.beginPath();
    ctx.moveTo(0, gy);
    ctx.bezierCurveTo(80, gy + 6, 170, gy - 6, TILE_PX, gy + 3);
    ctx.stroke();
  }
  grain(ctx, 122, 6);
}

function paintCardboard(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = '#b59a6b';
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
  // Packing tape stripe across the middle of the box top.
  ctx.fillStyle = 'rgba(214, 205, 175, 0.8)';
  ctx.fillRect(0, 108, TILE_PX, 40);
  ctx.strokeStyle = 'rgba(90, 72, 44, 0.6)';
  ctx.lineWidth = 2;
  ctx.strokeRect(6, 6, TILE_PX - 12, TILE_PX - 12);
  grain(ctx, 131, 8);
}
