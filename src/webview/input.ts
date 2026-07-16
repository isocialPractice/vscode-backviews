/**
 * Keyboard and mouse input. Movement follows the classic dual scheme the
 * generator's DEFAULT_CONTROLS describe (WASD plus arrow keys): W/S and
 * Up/Down walk, A/D strafe, Left/Right arrows and Q/E turn. Click captures
 * the pointer for mouse look when enabled.
 */

export interface InputState {
  forward: number;
  strafe: number;
  turn: number;
  running: boolean;
}

export class Input {
  private readonly held = new Set<string>();
  private lookDx = 0;
  mouseLookEnabled = true;
  onMenuToggle: (() => void) | null = null;
  private lookDy = 0;

  constructor(private readonly surface: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.key.toLowerCase() === 'm') {
        this.onMenuToggle?.();
        return;
      }
      this.held.add(normalize(e.key));
      if (isGameKey(e.key)) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.held.delete(normalize(e.key)));
    window.addEventListener('blur', () => this.held.clear());

    surface.addEventListener('click', () => {
      if (this.mouseLookEnabled && document.pointerLockElement !== surface) {
        surface.requestPointerLock();
      }
    });
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === this.surface) {
        this.lookDx += e.movementX;
        this.lookDy += e.movementY;
      }
    });
  }

  releasePointer(): void {
    if (document.pointerLockElement === this.surface) {
      document.exitPointerLock();
    }
  }

  /** Accumulated mouse-look delta since the last call, in pixels. */
  consumeLook(): { dx: number; dy: number } {
    const out = { dx: this.lookDx, dy: this.lookDy };
    this.lookDx = 0;
    this.lookDy = 0;
    return out;
  }

  state(): InputState {
    const has = (...keys: string[]): boolean => keys.some((k) => this.held.has(k));
    return {
      forward: (has('w', 'arrowup') ? 1 : 0) - (has('s', 'arrowdown') ? 1 : 0),
      strafe: (has('d') ? 1 : 0) - (has('a') ? 1 : 0),
      turn: (has('arrowright', 'e') ? 1 : 0) - (has('arrowleft', 'q') ? 1 : 0),
      running: has('shift'),
    };
  }
}

function normalize(key: string): string {
  return key.toLowerCase();
}

function isGameKey(key: string): boolean {
  return ['w', 'a', 's', 'd', 'q', 'e', 'shift'].includes(key.toLowerCase()) || key.startsWith('Arrow');
}
