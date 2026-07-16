/**
 * In-game pause menu built from plain DOM, layered above the film overlay.
 * Dark neutral surfaces with near-white text; the single warm accent is
 * reserved for the "Relocate" action.
 */
import { BackviewsSettings, SettingValue } from '../shared/settings';
import { WorldStats } from './world';

export interface MenuCallbacks {
  onResume: () => void;
  onRelocate: () => void;
  onSettingChange: (key: keyof BackviewsSettings, value: SettingValue) => void;
  onReseed: (seed: number) => void;
}

const STYLE = `
.bv-menu {
  position: absolute; inset: 0; display: none; z-index: 30;
  align-items: center; justify-content: center;
  background: rgba(16, 17, 19, 0.72);
  font-family: "Segoe UI", system-ui, sans-serif;
  color: #f0f2f3;
}
.bv-menu.open { display: flex; }
.bv-card {
  background: linear-gradient(#22252a, #1c1f23);
  border: 1px solid #3a3f46; border-radius: 10px;
  min-width: 300px; max-width: 380px; max-height: 82%; overflow-y: auto;
  padding: 22px 26px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
}
.bv-card h1 { margin: 0 0 2px; font-size: 20px; letter-spacing: 3px; font-weight: 600; }
.bv-card .bv-sub { margin: 0 0 18px; font-size: 12px; color: #9aa3ad; }
.bv-menu button {
  display: block; width: 100%; margin: 8px 0; padding: 10px 14px;
  background: #2b3036; color: #f0f2f3; border: 1px solid #454c55;
  border-radius: 6px; font-size: 14px; cursor: pointer; text-align: left;
}
.bv-menu button:hover { background: #343a42; }
.bv-menu button.bv-accent { background: #6b4b12; border-color: #93691c; }
.bv-menu button.bv-accent:hover { background: #7d5915; }
.bv-row { display: flex; align-items: center; justify-content: space-between; margin: 10px 0; font-size: 13px; gap: 12px; }
.bv-row label { flex: 1; color: #cfd6dc; }
.bv-row input[type="checkbox"] { width: 16px; height: 16px; accent-color: #93691c; }
.bv-row input[type="range"] { width: 130px; accent-color: #93691c; }
.bv-row input[type="number"] {
  width: 110px; background: #15171a; color: #f0f2f3;
  border: 1px solid #454c55; border-radius: 4px; padding: 5px 7px; font-size: 13px;
}
.bv-row .bv-val { width: 34px; text-align: right; color: #9aa3ad; font-variant-numeric: tabular-nums; }
.bv-row select {
  background: #15171a; color: #f0f2f3; border: 1px solid #454c55;
  border-radius: 4px; padding: 5px 7px; font-size: 13px; min-width: 150px;
}
.bv-h {
  margin: 16px 0 4px; font-size: 11px; letter-spacing: 2px;
  color: #8a93a0; text-transform: uppercase;
}
.bv-h:first-of-type { margin-top: 8px; }
.bv-stats { margin-top: 14px; padding-top: 12px; border-top: 1px solid #33383f; font-size: 12px; color: #9aa3ad; line-height: 1.7; }
.bv-help { font-size: 13px; color: #cfd6dc; line-height: 1.9; }
.bv-help kbd {
  background: #15171a; border: 1px solid #454c55; border-radius: 4px;
  padding: 1px 6px; font-family: inherit; font-size: 12px;
}
.bv-back { margin-top: 16px !important; }
`;

export class Menu {
  private readonly root: HTMLElement;
  private readonly views: Record<'main' | 'settings' | 'help', HTMLElement>;
  private statsEl: HTMLElement | null = null;
  private settings: BackviewsSettings | null = null;
  private openFlag = false;

  constructor(parent: HTMLElement, private readonly callbacks: MenuCallbacks) {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);

    this.root = document.createElement('div');
    this.root.className = 'bv-menu';
    parent.appendChild(this.root);

    this.views = {
      main: this.buildMain(),
      settings: this.buildSettings(),
      help: this.buildHelp(),
    };
    for (const view of Object.values(this.views)) {
      this.root.appendChild(view);
    }
    this.show('main');
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  open(): void {
    this.openFlag = true;
    this.root.classList.add('open');
    this.show('main');
  }

  close(): void {
    this.openFlag = false;
    this.root.classList.remove('open');
  }

  syncSettings(settings: BackviewsSettings): void {
    this.settings = settings;
    for (const input of this.root.querySelectorAll<HTMLInputElement>('[data-key]')) {
      const key = input.dataset.key as keyof BackviewsSettings;
      const value = settings[key];
      if (input.type === 'checkbox') {
        input.checked = Boolean(value);
      } else {
        input.value = String(value);
        const label = input.parentElement?.querySelector('.bv-val');
        if (label) {
          label.textContent = String(value);
        }
      }
    }
  }

  syncStats(stats: WorldStats): void {
    if (this.statsEl) {
      this.statsEl.innerHTML =
        `seed <b>${stats.seed}</b><br>` +
        `cells visited <b>${stats.cellsVisited}</b><br>` +
        `cells cached <b>${stats.cacheSize}</b>`;
    }
  }

  private show(name: 'main' | 'settings' | 'help'): void {
    for (const [key, view] of Object.entries(this.views)) {
      view.style.display = key === name ? 'block' : 'none';
    }
  }

  private card(): HTMLElement {
    const card = document.createElement('div');
    card.className = 'bv-card';
    card.innerHTML = '<h1>BACKVIEWS</h1><p class="bv-sub">no-clipped into a VSCode webview</p>';
    return card;
  }

  private button(label: string, onClick: () => void, accent = false): HTMLButtonElement {
    const button = document.createElement('button');
    button.textContent = label;
    if (accent) {
      button.className = 'bv-accent';
    }
    button.addEventListener('click', onClick);
    return button;
  }

  private buildMain(): HTMLElement {
    const card = this.card();
    card.appendChild(this.button('Resume', () => this.callbacks.onResume()));
    card.appendChild(this.button('Relocate (new seed)', () => this.callbacks.onRelocate(), true));
    card.appendChild(this.button('Settings', () => this.show('settings')));
    card.appendChild(this.button('Help', () => this.show('help')));
    this.statsEl = document.createElement('div');
    this.statsEl.className = 'bv-stats';
    card.appendChild(this.statsEl);
    return card;
  }

  private toggleRow(label: string, key: keyof BackviewsSettings): HTMLElement {
    const row = document.createElement('div');
    row.className = 'bv-row';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.key = key;
    input.addEventListener('change', () => this.callbacks.onSettingChange(key, input.checked));
    const text = document.createElement('label');
    text.textContent = label;
    row.append(text, input);
    return row;
  }

  private sliderRow(
    label: string,
    key: keyof BackviewsSettings,
    min: number,
    max: number,
    stepSize: number,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'bv-row';
    const text = document.createElement('label');
    text.textContent = label;
    const value = document.createElement('span');
    value.className = 'bv-val';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(stepSize);
    input.dataset.key = key;
    input.addEventListener('input', () => {
      value.textContent = input.value;
      this.callbacks.onSettingChange(key, Number(input.value));
    });
    row.append(text, input, value);
    return row;
  }

  private heading(text: string): HTMLElement {
    const h = document.createElement('div');
    h.className = 'bv-h';
    h.textContent = text;
    return h;
  }

  private selectRow(
    label: string,
    key: keyof BackviewsSettings,
    options: { value: string; label: string }[],
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'bv-row';
    const text = document.createElement('label');
    text.textContent = label;
    const select = document.createElement('select');
    select.dataset.key = key;
    for (const option of options) {
      const el = document.createElement('option');
      el.value = option.value;
      el.textContent = option.label;
      select.appendChild(el);
    }
    select.addEventListener('change', () => this.callbacks.onSettingChange(key, select.value));
    row.append(text, select);
    return row;
  }

  private buildSettings(): HTMLElement {
    const card = this.card();

    card.appendChild(this.heading('Camera'));
    card.appendChild(this.toggleRow('Camera shake', 'cameraShake'));
    card.appendChild(this.toggleRow('Film grain', 'filmGrain'));
    card.appendChild(this.toggleRow('Camcorder HUD', 'vhsHud'));

    card.appendChild(this.heading('Controls'));
    card.appendChild(this.toggleRow('Mouse look', 'mouseLook'));
    card.appendChild(this.toggleRow('Invert turn', 'invertTurn'));
    card.appendChild(this.toggleRow('Invert strafe', 'invertStrafe'));
    card.appendChild(this.toggleRow('Invert forward/back', 'invertForward'));
    card.appendChild(this.sliderRow('Walk speed', 'moveSpeed', 0.5, 6, 0.1));

    card.appendChild(this.heading('Materials'));
    card.appendChild(
      this.selectRow('Wall material', 'materialPreset', [
        { value: 'classic', label: 'Classic wallpaper mix' },
        { value: 'office', label: 'Plain drywall' },
        { value: 'pool', label: 'Ceramic tile' },
        { value: 'concrete', label: 'Bare concrete' },
        { value: 'panel', label: 'Wood paneling' },
      ]),
    );
    card.appendChild(this.sliderRow('Hue shift', 'materialHueShift', -180, 180, 5));
    card.appendChild(this.sliderRow('Brightness', 'materialBrightness', 0.6, 1.4, 0.05));

    card.appendChild(this.heading('Monster'));
    card.appendChild(this.toggleRow('Monster', 'monsterEnabled'));
    card.appendChild(
      this.selectRow('Form', 'monsterForm', [
        { value: 'spider', label: 'Spider-like' },
        { value: 'humanoid', label: 'Human-like' },
        { value: 'cloud', label: 'Cloud-like' },
        { value: 'random', label: 'Random each spawn' },
      ]),
    );
    card.appendChild(this.sliderRow('Speed', 'monsterSpeed', 0.5, 5, 0.1));
    card.appendChild(this.sliderRow('Spawn after (min)', 'monsterSpawnMin', 0.1, 10, 0.1));
    card.appendChild(this.sliderRow('Spawn before (min)', 'monsterSpawnMax', 0.5, 15, 0.5));

    card.appendChild(this.heading('World'));
    card.appendChild(this.toggleRow('Furniture', 'furniture'));
    card.appendChild(this.toggleRow('Wallpaper shifts', 'wallpaperShifts'));
    card.appendChild(this.sliderRow('Render distance', 'renderDistance', 6, 28, 1));

    card.appendChild(this.heading('Copilot'));
    card.appendChild(this.toggleRow('Ghost-writer on the walls', 'copilotGhostWriter'));

    const seedRow = document.createElement('div');
    seedRow.className = 'bv-row';
    const seedLabel = document.createElement('label');
    seedLabel.textContent = 'Seed (0 = random)';
    const seedInput = document.createElement('input');
    seedInput.type = 'number';
    seedInput.dataset.key = 'seed';
    seedInput.addEventListener('change', () => {
      const seed = Math.trunc(Number(seedInput.value)) || 0;
      this.callbacks.onSettingChange('seed', seed);
      this.callbacks.onReseed(seed);
    });
    seedRow.append(seedLabel, seedInput);
    card.appendChild(seedRow);

    const back = this.button('Back', () => this.show('main'));
    back.classList.add('bv-back');
    card.appendChild(back);
    return card;
  }

  private buildHelp(): HTMLElement {
    const card = this.card();
    const help = document.createElement('div');
    help.className = 'bv-help';
    help.innerHTML =
      '<kbd>W</kbd>/<kbd>S</kbd> or <kbd>&uarr;</kbd>/<kbd>&darr;</kbd> walk<br>' +
      '<kbd>A</kbd>/<kbd>D</kbd> strafe<br>' +
      '<kbd>&larr;</kbd>/<kbd>&rarr;</kbd> or <kbd>Q</kbd>/<kbd>E</kbd> turn<br>' +
      '<kbd>Shift</kbd> hurry<br>' +
      'click the view for mouse look<br>' +
      '<kbd>M</kbd> or <kbd>Esc</kbd> open this menu<br><br>' +
      'The maze is infinite and deterministic: the same seed always rebuilds the same rooms.';
    card.appendChild(help);
    const back = this.button('Back', () => this.show('main'));
    back.classList.add('bv-back');
    card.appendChild(back);
    return card;
  }
}
