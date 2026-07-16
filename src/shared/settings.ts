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

/**
 * A Copilot job snapshot, bridged in from the status file or the
 * `backviews.reportJob` command. While `working` is true the status text is
 * scrawled on the walls and the HUD shows a live token counter.
 */
export interface CopilotJob {
  /** Whether the agent is actively working right now. */
  working: boolean;
  /** Short human-readable description of the current job step. */
  status: string;
  /** Tokens consumed by the current job so far. */
  tokens: number;
}

export const IDLE_JOB: CopilotJob = { working: false, status: '', tokens: 0 };

/** One completed Copilot Chat exchange, already trimmed for wall display. */
export interface ChatExchange {
  prompt: string;
  response: string;
}

/**
 * Snapshot of the workspace's most recent Copilot Chat session, read from
 * VSCode's chat session store. History is written on walls statically; the
 * current response is ghost-written live as it streams.
 */
export interface ChatSessionSnapshot {
  /** Whether the newest response is still streaming. */
  working: boolean;
  /** Older exchanges (newest last), excluding the current response. */
  history: ChatExchange[];
  /** The newest response's text so far (clipped; grows while streaming). */
  current: string;
  /** Approximate tokens of the newest response (chars / 4). */
  tokens: number;
}

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
  /**
   * Copilot ghost-writer: while Copilot works, its chat responses and job
   * status are scrawled live on nearby walls as they stream, and a camcorder
   * token counter runs under the HUD battery. One toggle for the whole
   * feature.
   */
  copilotGhostWriter: boolean;
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
  copilotGhostWriter: true,
};

export type SettingValue = number | boolean | string;

/** Messages sent from the extension host into the webview. */
export type HostMessage =
  | { type: 'config'; settings: BackviewsSettings }
  | { type: 'relocate' }
  | { type: 'jobStatus'; job: CopilotJob }
  | { type: 'chatSession'; session: ChatSessionSnapshot };

/** Messages sent from the webview back to the extension host. */
export type WebviewMessage =
  | { type: 'ready' }
  | { type: 'updateSetting'; key: keyof BackviewsSettings; value: SettingValue };
