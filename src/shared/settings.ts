/**
 * Settings shared between the extension host and the webview. The extension
 * reads them from VSCode configuration; the webview applies them live and can
 * request persistence through `updateSetting` messages.
 */

export type MaterialPreset = 'classic' | 'office' | 'pool' | 'concrete' | 'panel';
export type MonsterForm = 'spider' | 'humanoid' | 'cloud' | 'random';

export const MATERIAL_PRESET_IDS: readonly MaterialPreset[] = [
  'classic',
  'office',
  'pool',
  'concrete',
  'panel',
];

export const MONSTER_FORM_IDS: readonly MonsterForm[] = ['spider', 'humanoid', 'cloud', 'random'];

export interface BackviewsSettings {
  /** Maze seed; 0 means "pick a random seed when the panel opens". */
  seed: number;
  /** Walking speed in cells per second. */
  moveSpeed: number;
  /** Radius, in cells, of the meshed and drawn neighborhood. */
  renderDistance: number;
  /** Handheld sway plus walking head-bob. */
  cameraShake: boolean;
  /** Grain, vignette, and tracking-noise overlay. */
  filmGrain: boolean;
  /** Camcorder REC dot, timestamp, and tape-mode HUD. */
  vhsHud: boolean;
  /** Render generator-placed furniture and columns. */
  furniture: boolean;
  /** Tint/pattern shifts inside randomly shaped wallpaper zones. */
  wallpaperShifts: boolean;
  /** Pointer-lock mouse look on click. */
  mouseLook: boolean;
  /** Flip turn direction (mouse and turn keys). */
  invertTurn: boolean;
  /** Flip strafe left/right. */
  invertStrafe: boolean;
  /** Flip forward/back. */
  invertForward: boolean;
  /** Pre-built wall material set. */
  materialPreset: MaterialPreset;
  /** Wall hue rotation in degrees, -180..180. */
  materialHueShift: number;
  /** Wall brightness multiplier, 0.6..1.4. */
  materialBrightness: number;
  /** Whether something else walks these halls. */
  monsterEnabled: boolean;
  /** Monster speed in cells per second. */
  monsterSpeed: number;
  /** Earliest spawn, minutes after the world starts. */
  monsterSpawnMin: number;
  /** Latest spawn, minutes after the world starts. */
  monsterSpawnMax: number;
  /** Monster body plan; `random` rolls a new form each spawn. */
  monsterForm: MonsterForm;
}

export const DEFAULT_SETTINGS: BackviewsSettings = {
  seed: 0,
  moveSpeed: 2.2,
  renderDistance: 14,
  cameraShake: true,
  filmGrain: true,
  vhsHud: true,
  furniture: true,
  wallpaperShifts: false,
  mouseLook: true,
  invertTurn: false,
  invertStrafe: false,
  invertForward: false,
  materialPreset: 'classic',
  materialHueShift: 0,
  materialBrightness: 1,
  monsterEnabled: true,
  monsterSpeed: 2.6,
  monsterSpawnMin: 1,
  monsterSpawnMax: 5,
  monsterForm: 'random',
};

export type SettingValue = number | boolean | string;

/** Messages sent from the extension host into the webview. */
export type HostMessage =
  | { type: 'config'; settings: BackviewsSettings }
  | { type: 'relocate' };

/** Messages sent from the webview back to the extension host. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'updateSetting'; key: keyof BackviewsSettings; value: SettingValue };
