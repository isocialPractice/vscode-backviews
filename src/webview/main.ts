/**
 * Webview entry point: wires the renderer, world, input, film overlay, and
 * menu together and runs the frame loop. Talks to the extension host for
 * settings persistence.
 */
import { BackviewsSettings, DEFAULT_SETTINGS, HostMessage, SettingValue, WebviewMessage } from '../shared/settings';
import { FilmOverlay } from './film';
import { WallWriting } from './graffiti';
import { Input } from './input';
import { Monster, MonsterConfig } from './monster';
import { Camera, Renderer } from './renderer';
import { Menu } from './menu';
import { World } from './world';

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewMessage): void;
  getState(): PersistedState | undefined;
  setState(state: PersistedState): void;
};

declare global {
  interface Window {
    /** Webview URIs for materials/*.jpg, injected by the extension host. */
    __BACKVIEWS_MATERIALS__?: { wallpaper?: string; ceiling?: string; carpet?: string };
  }
}

interface PersistedState {
  seed: number;
  px: number;
  py: number;
  yaw: number;
}

const EYE_HEIGHT = 0.78;

const vscode = acquireVsCodeApi();

class Game {
  private settings: BackviewsSettings = { ...DEFAULT_SETTINGS };
  private readonly renderer: Renderer;
  private readonly film: FilmOverlay;
  private readonly graffiti = new WallWriting();
  private readonly input: Input;
  private readonly menu: Menu;
  private readonly toast: HTMLElement;
  private world: World;
  private monster: Monster | null = null;
  private uniformWallpaper = false;

  // Player, in plane coordinates.
  private px = 0.5;
  private py = 0.5;
  private yaw = 0;
  private pitch = 0;
  private bobPhase = 0;
  private lastFrame = 0;
  private lastPersist = 0;
  private flickerDipUntil = 0;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(root: HTMLElement) {
    const glCanvas = document.createElement('canvas');
    const filmCanvas = document.createElement('canvas');
    for (const [canvas, z] of [[glCanvas, '1'], [filmCanvas, '2']] as const) {
      canvas.style.cssText = `position:absolute;inset:0;width:100%;height:100%;z-index:${z};`;
    }
    filmCanvas.style.pointerEvents = 'none';
    root.append(glCanvas, filmCanvas);

    this.renderer = new Renderer(glCanvas);
    this.film = new FilmOverlay(filmCanvas);
    this.input = new Input(glCanvas);
    this.input.onMenuToggle = () => this.toggleMenu();

    this.menu = new Menu(root, {
      onResume: () => this.toggleMenu(),
      onRelocate: () => this.relocate(),
      onSettingChange: (key, value) => this.changeSetting(key, value),
      // A nonzero seed already rebuilds through applySettings; 0 means "roll one now".
      onReseed: (seed) => {
        if (seed === 0) {
          this.rebuildWorld(randomSeed());
        }
      },
    });

    this.toast = document.createElement('div');
    this.toast.style.cssText =
      'position:absolute;left:50%;bottom:9%;transform:translateX(-50%);z-index:20;' +
      'background:rgba(22,24,27,0.85);color:#f0f2f3;border:1px solid #454c55;border-radius:6px;' +
      'padding:8px 16px;font:13px "Segoe UI",system-ui,sans-serif;opacity:0;transition:opacity .4s;' +
      'pointer-events:none;';
    root.appendChild(this.toast);

    const restored = vscode.getState();
    const seed = restored?.seed ?? (this.settings.seed !== 0 ? this.settings.seed : randomSeed());
    this.world = new World(seed);
    if (restored) {
      this.px = restored.px;
      this.py = restored.py;
      this.yaw = restored.yaw;
      this.world.session.warpTo(Math.floor(this.px), Math.floor(this.py));
    }

    window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
      const message = event.data;
      if (message.type === 'config') {
        this.applySettings(message.settings);
      } else if (message.type === 'relocate') {
        this.relocate();
      } else if (message.type === 'jobStatus') {
        this.film.setJob(message.job);
        this.graffiti.setJob(message.job);
      } else if (message.type === 'chatSession') {
        // Chat sessions feed the same surfaces: response tokens drive the HUD
        // counter, and the session text drives the wall writing.
        this.film.setJob({
          working: message.session.working,
          status: '',
          tokens: message.session.tokens,
        });
        this.graffiti.setSession(message.session);
      }
    });
    vscode.postMessage({ type: 'ready' });

    this.showToast(`seed ${seed} - walk with WASD or arrows, M for menu`);
    this.syncMonster();
    void this.loadMaterialImages();
    requestAnimationFrame((t) => this.frame(t));
  }

  /**
   * Loads the photo materials shipped under materials/ and patches them over
   * the procedural atlas. Any file that is missing or fails to decode leaves
   * its procedural tile in place.
   */
  private async loadMaterialImages(): Promise<void> {
    const uris = window.__BACKVIEWS_MATERIALS__ ?? {};
    const load = (uri: string | undefined): Promise<HTMLImageElement | undefined> =>
      new Promise((resolve) => {
        if (!uri) {
          resolve(undefined);
          return;
        }
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => resolve(undefined);
        image.src = uri;
      });

    const [wallpaper, ceiling, carpet] = await Promise.all([
      load(uris.wallpaper),
      load(uris.ceiling),
      load(uris.carpet),
    ]);
    if (!wallpaper && !ceiling && !carpet) {
      return;
    }
    this.renderer.applyMaterialImages({ wallpaper, ceiling, carpet });
    if (wallpaper) {
      // With a real wallpaper photo, the classic preset papers every wall.
      this.world.uniformWallpaper = true;
      this.uniformWallpaper = true;
      this.world.invalidateChunks(this.renderer);
    }
  }

  private toggleMenu(): void {
    if (this.menu.isOpen) {
      this.menu.close();
    } else {
      this.input.releasePointer();
      this.menu.syncSettings(this.settings);
      this.menu.syncStats(this.world.stats());
      this.menu.open();
    }
  }

  private relocate(): void {
    const seed = randomSeed();
    this.rebuildWorld(seed);
    this.menu.close();
    this.showToast(`relocated to seed ${seed}`);
  }

  private rebuildWorld(seed: number): void {
    this.world.invalidateChunks(this.renderer);
    this.graffiti.reset(this.renderer);
    this.world = new World(seed);
    this.world.furnitureEnabled = this.settings.furniture;
    this.world.wallpaperShiftsEnabled = this.settings.wallpaperShifts;
    this.world.setMaterial(
      this.settings.materialPreset,
      this.settings.materialHueShift,
      this.settings.materialBrightness,
    );
    this.world.uniformWallpaper = this.uniformWallpaper;
    this.px = 0.5;
    this.py = 0.5;
    this.syncMonster(true);
    this.persist();
    this.menu.syncStats(this.world.stats());
  }

  private monsterConfig(): MonsterConfig {
    return {
      speed: this.settings.monsterSpeed,
      spawnMinMs: this.settings.monsterSpawnMin * 60_000,
      spawnMaxMs: this.settings.monsterSpawnMax * 60_000,
      form: this.settings.monsterForm,
    };
  }

  /** Creates, retunes, or removes the monster to match current settings. */
  private syncMonster(rearm = false): void {
    if (!this.settings.monsterEnabled) {
      this.monster = null;
      this.renderer.clearDynamicMesh();
      return;
    }
    if (!this.monster || rearm) {
      this.monster = new Monster(this.world, this.monsterConfig(), performance.now());
    } else {
      this.monster.configure(this.monsterConfig());
    }
  }

  private changeSetting(key: keyof BackviewsSettings, value: SettingValue): void {
    this.applySettings({ ...this.settings, [key]: value });
    vscode.postMessage({ type: 'updateSetting', key, value });
  }

  private applySettings(settings: BackviewsSettings): void {
    const previous = this.settings;
    this.settings = settings;
    this.film.grainEnabled = settings.filmGrain;
    this.film.hudEnabled = settings.vhsHud;
    // The Copilot ghost-writer is one toggle over both surfaces: the HUD token
    // counter and the wall writing. Turning it off wipes any writing in place.
    this.film.tokenCounterEnabled = settings.copilotGhostWriter;
    if (this.graffiti.enabled && !settings.copilotGhostWriter) {
      this.graffiti.reset(this.renderer);
    }
    this.graffiti.enabled = settings.copilotGhostWriter;
    this.input.mouseLookEnabled = settings.mouseLook;
    // Fog closes in just before the mesh edge does.
    this.renderer.fogDensity = 2.6 / (settings.renderDistance * settings.renderDistance);

    if (
      previous.furniture !== settings.furniture ||
      previous.wallpaperShifts !== settings.wallpaperShifts ||
      previous.materialPreset !== settings.materialPreset ||
      previous.materialHueShift !== settings.materialHueShift ||
      previous.materialBrightness !== settings.materialBrightness
    ) {
      this.world.furnitureEnabled = settings.furniture;
      this.world.wallpaperShiftsEnabled = settings.wallpaperShifts;
      this.world.setMaterial(settings.materialPreset, settings.materialHueShift, settings.materialBrightness);
      this.world.invalidateChunks(this.renderer);
    }
    this.syncMonster(previous.monsterEnabled !== settings.monsterEnabled);
    if (settings.seed !== previous.seed && settings.seed !== 0 && settings.seed !== this.world.seed) {
      this.rebuildWorld(settings.seed);
    }
    this.menu.syncSettings(settings);
  }

  private showToast(text: string): void {
    this.toast.textContent = text;
    this.toast.style.opacity = '1';
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast.style.opacity = '0';
    }, 4200);
  }

  private persist(): void {
    vscode.setState({ seed: this.world.seed, px: this.px, py: this.py, yaw: this.yaw });
  }

  private frame(now: number): void {
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000 || 0.016);
    this.lastFrame = now;
    const t = now / 1000;

    let speed = 0;
    if (!this.menu.isOpen) {
      speed = this.step(dt);
      if (this.monster) {
        const event = this.monster.update(now, dt, this.px, this.py);
        if (event === 'spawned') {
          this.showToast('the air changes. something else is in the halls.');
        } else if (event === 'caught') {
          this.film.burst(now);
          this.px = 0.5;
          this.py = 0.5;
          this.world.session.warpTo(0, 0);
          this.persist();
          this.showToast('tape resumes somewhere familiar. it is still out there.');
        }
      }
    }
    if (this.monster?.isStalking) {
      const mesh = this.monster.buildMesh(now, this.px, this.py);
      this.renderer.setDynamicMesh(mesh.vertices, mesh.indices);
    } else {
      this.renderer.clearDynamicMesh();
    }

    // Handheld sway plus walking bob, both gated by the camera-shake setting.
    let shakeYaw = 0;
    let shakePitch = 0;
    let shakeRoll = 0;
    let shakeUp = 0;
    if (this.settings.cameraShake) {
      const drift = 1 + speed * 1.6;
      shakeYaw = (Math.sin(t * 0.9) * 0.006 + Math.sin(t * 2.3 + 1.7) * 0.003) * drift;
      shakePitch = (Math.sin(t * 1.3 + 0.6) * 0.004 + Math.sin(t * 3.1) * 0.002) * drift;
      shakeRoll = Math.sin(t * 0.7 + 2.1) * 0.004 * drift + Math.sin(this.bobPhase) * 0.006 * speed;
      shakeUp = Math.sin(this.bobPhase * 2) * 0.014 * speed;
    }

    // Fluorescent flicker: gentle hum plus rare deep dips.
    if (Math.random() < 0.0015 && this.flickerDipUntil < now) {
      this.flickerDipUntil = now + 60 + Math.random() * 120;
    }
    let flicker = 1 + Math.sin(t * 11) * 0.012 + Math.sin(t * 47) * 0.008;
    if (this.flickerDipUntil > now) {
      flicker *= 0.82;
    }

    const camera: Camera = {
      x: this.px,
      y: EYE_HEIGHT + shakeUp,
      z: this.py,
      yaw: this.yaw + shakeYaw,
      pitch: this.pitch + shakePitch,
      roll: shakeRoll,
      fovY: (72 * Math.PI) / 180,
    };

    this.graffiti.update(now, this.world, this.px, this.py, this.yaw, this.renderer);
    const chunks = this.world.updateChunks(this.px, this.py, this.settings.renderDistance, this.renderer);
    this.renderer.draw(chunks, camera, flicker);
    this.film.render(now);

    if (now - this.lastPersist > 1500) {
      this.lastPersist = now;
      this.persist();
    }
    requestAnimationFrame((next) => this.frame(next));
  }

  /** Applies input to the player; returns normalized speed for bob effects. */
  private step(dt: number): number {
    const input = this.input.state();
    const look = this.input.consumeLook();
    const turnSign = this.settings.invertTurn ? -1 : 1;
    // View matrix forward is (-sin yaw, -cos yaw) in plane coords, so turning
    // right (north toward east) means decreasing yaw.
    this.yaw -= (look.dx * 0.0026 + input.turn * 1.9 * dt) * turnSign;
    this.pitch = clamp(this.pitch - look.dy * 0.0022, -1.25, 1.25);

    const rate = this.settings.moveSpeed * (input.running ? 1.7 : 1);
    const forward = input.forward * (this.settings.invertForward ? -1 : 1);
    const strafe = input.strafe * (this.settings.invertStrafe ? -1 : 1);
    // Camera-relative basis matching the renderer's view matrix exactly:
    // forward = (-sin yaw, -cos yaw), screen-right = (cos yaw, -sin yaw).
    const fx = -Math.sin(this.yaw);
    const fy = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw);
    const ry = -Math.sin(this.yaw);
    const dx = (fx * forward + rx * strafe) * rate * dt;
    const dy = (fy * forward + ry * strafe) * rate * dt;
    if (dx === 0 && dy === 0) {
      return 0;
    }

    const moved = this.world.moveResolved(this.px, this.py, dx, dy);
    const actual = Math.hypot(moved.x - this.px, moved.y - this.py);
    this.px = moved.x;
    this.py = moved.y;
    this.world.syncSession(this.px, this.py);
    this.bobPhase += actual * 5.6;
    return Math.min(1, actual / (rate * dt + 1e-6));
  }
}

function randomSeed(): number {
  return Math.floor(Math.random() * 999_999) + 1;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

const app = document.getElementById('app');
if (app) {
  new Game(app);
}
