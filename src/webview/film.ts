/**
 * Grainy camcorder overlay, styled after a 1990-era handheld tape camera:
 * animated film grain, vignette, occasional tracking tears, and a HUD with a
 * blinking REC dot, tape counter, battery pips, and a burned-in timestamp.
 * Drawn on a 2D canvas layered above the WebGL view.
 */

const GRAIN_TILE = 160;
const GRAIN_VARIANTS = 5;
const GRAIN_FPS = 18;

export class FilmOverlay {
  grainEnabled = true;
  hudEnabled = true;

  private readonly ctx: CanvasRenderingContext2D;
  private readonly grainTiles: HTMLCanvasElement[] = [];
  private lastGrainAt = 0;
  private grainIndex = 0;
  private tearY = -1;
  private tearUntil = 0;
  private burstUntil = 0;
  private readonly startedAt = Date.now();

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('2D overlay context unavailable');
    }
    this.ctx = ctx;
    for (let v = 0; v < GRAIN_VARIANTS; v++) {
      this.grainTiles.push(makeGrainTile(v));
    }
  }

  /** Cuts the picture to heavy static for a moment (the catch effect). */
  burst(now: number, durationMs = 1300): void {
    this.burstUntil = now + durationMs;
  }

  render(now: number): void {
    const canvas = this.canvas;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) {
      return;
    }
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = this.ctx;
    ctx.clearRect(0, 0, w, h);

    // Full-signal static: drawn regardless of the grain setting.
    if (this.burstUntil > now) {
      ctx.globalAlpha = 0.94;
      for (let y = 0; y < h; y += GRAIN_TILE) {
        for (let x = 0; x < w; x += GRAIN_TILE) {
          ctx.drawImage(this.grainTiles[Math.floor(Math.random() * GRAIN_VARIANTS)]!, x, y);
        }
      }
      ctx.globalAlpha = 1;
      ctx.font = 'bold 28px "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(20, 20, 20, 0.85)';
      ctx.fillRect(w / 2 - 130, h / 2 - 28, 260, 56);
      ctx.fillStyle = '#f0f2f3';
      ctx.fillText('SIGNAL LOST', w / 2, h / 2);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      return;
    }

    if (!this.grainEnabled && !this.hudEnabled) {
      return;
    }

    if (this.grainEnabled) {
      // Grain runs below display refresh so it strobes like real tape noise.
      if (now - this.lastGrainAt > 1000 / GRAIN_FPS) {
        this.lastGrainAt = now;
        this.grainIndex = Math.floor(Math.random() * GRAIN_VARIANTS);
        if (this.tearUntil < now && Math.random() < 0.03) {
          this.tearY = Math.random() * h;
          this.tearUntil = now + 90 + Math.random() * 160;
        }
      }
      const tile = this.grainTiles[this.grainIndex]!;
      ctx.globalAlpha = 0.11;
      const ox = Math.floor(Math.random() * GRAIN_TILE);
      const oy = Math.floor(Math.random() * GRAIN_TILE);
      for (let y = -oy; y < h; y += GRAIN_TILE) {
        for (let x = -ox; x < w; x += GRAIN_TILE) {
          ctx.drawImage(tile, x, y);
        }
      }
      ctx.globalAlpha = 1;

      // Vignette.
      const grad = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.42, w / 2, h / 2, Math.max(w, h) * 0.72);
      grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
      grad.addColorStop(1, 'rgba(0, 0, 0, 0.42)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // Faint rolling scanline band.
      const bandY = ((now / 34) % (h + 160)) - 160;
      const band = ctx.createLinearGradient(0, bandY, 0, bandY + 160);
      band.addColorStop(0, 'rgba(255, 255, 255, 0)');
      band.addColorStop(0.5, 'rgba(255, 255, 255, 0.025)');
      band.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = band;
      ctx.fillRect(0, bandY, w, 160);

      // Occasional horizontal tracking tear.
      if (this.tearUntil > now && this.tearY >= 0) {
        ctx.fillStyle = 'rgba(220, 220, 210, 0.10)';
        ctx.fillRect(0, this.tearY, w, 3);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.16)';
        ctx.fillRect(0, this.tearY + 3, w, 2);
      }
    }

    if (this.hudEnabled) {
      this.renderHud(now, w, h);
    }
  }

  private renderHud(now: number, w: number, h: number): void {
    const ctx = this.ctx;
    const pad = Math.round(Math.min(w, h) * 0.045) + 8;
    ctx.font = '16px "Courier New", monospace';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(235, 235, 225, 0.9)';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
    ctx.shadowBlur = 3;

    // Blinking REC dot, upper-left.
    if (Math.floor(now / 700) % 2 === 0) {
      ctx.fillStyle = 'rgba(255, 70, 60, 0.95)';
      ctx.beginPath();
      ctx.arc(pad + 7, pad + 8, 6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(235, 235, 225, 0.9)';
    ctx.fillText('REC', pad + 22, pad);

    // Tape mode + counter, upper-right.
    const elapsed = Math.floor((Date.now() - this.startedAt) / 1000);
    const counter = `${String(Math.floor(elapsed / 3600)).padStart(1, '0')}:${String(
      Math.floor((elapsed / 60) % 60),
    ).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`;
    ctx.textAlign = 'right';
    ctx.fillText(`SP ${counter}`, w - pad, pad);

    // Battery pips under the tape counter.
    ctx.strokeStyle = 'rgba(235, 235, 225, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(w - pad - 34, pad + 24, 30, 12);
    ctx.fillRect(w - pad - 3, pad + 27, 3, 6);
    ctx.fillRect(w - pad - 32, pad + 26, 8, 8);
    ctx.fillRect(w - pad - 22, pad + 26, 8, 8);

    // Burned-in timestamp, lower-left, camcorder date format.
    ctx.textAlign = 'left';
    const stamp = new Date();
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const hr = stamp.getHours() % 12 === 0 ? 12 : stamp.getHours() % 12;
    const ampm = stamp.getHours() < 12 ? 'AM' : 'PM';
    const text = `${months[stamp.getMonth()]} ${String(stamp.getDate()).padStart(2, '0')} 1990  ${ampm} ${hr}:${String(
      stamp.getMinutes(),
    ).padStart(2, '0')}`;
    ctx.fillStyle = 'rgba(240, 214, 130, 0.92)';
    ctx.fillText(text, pad, h - pad - 18);

    ctx.shadowBlur = 0;
    ctx.textAlign = 'left';
  }
}

function makeGrainTile(seed: number): HTMLCanvasElement {
  const tile = document.createElement('canvas');
  tile.width = tile.height = GRAIN_TILE;
  const ctx = tile.getContext('2d')!;
  const image = ctx.createImageData(GRAIN_TILE, GRAIN_TILE);
  let state = 0x9e3779b9 ^ (seed * 0x85ebca6b);
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
  for (let i = 0; i < image.data.length; i += 4) {
    const v = Math.floor(next() * 255);
    image.data[i] = v;
    image.data[i + 1] = v;
    image.data[i + 2] = v;
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return tile;
}
