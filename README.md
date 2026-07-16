# VSCode BackViews

<p align="center">
  <br />
  <a title="Header logo" href="http://github.com/isocialPractice/vscode-backviews"><img src="https://raw.githubusercontent.com/isocialPractice/vscode-backviews/main/media/logo.png" alt="BackViews Logo" width="50%" /></a>
</p>

A first-person backrooms explorer that runs inside a VSCode webview. Endless yellow-wallpapered
halls under humming fluorescent panels, drop-tile ceilings, and worn office carpet, filmed
through the shake and grain of a 1990-era handheld camcorder. Somewhere past the fog, something
else walks the same halls.

BackViews is built on [cmd-backedges](https://github.com/isocialPractice/cmd-backedges), the
procedural infinite maze engine that serves as the base for this project: every wall, room, and
prop is a pure function of the seed, so the same seed always rebuilds the same rooms, forever,
in every direction.

As for the name: a VSCode extension is expected to contribute a view or two. These views just
do not end.

- [Installation](#installation)
- [Getting Started](#getting-started)
- [Game Play](#game-play)
- [Settings](#settings)
- [API Quick Overview](#api-quick-overview)
- [Architecture](#architecture)

## Installation

Prerequisites:

- [VSCode](https://code.visualstudio.com/) 1.85 or newer
- [Node.js](https://nodejs.org/) 18 or newer
- [cmd-backedges](https://github.com/isocialPractice/cmd-backedges) checked out next to this
  folder (the build bundles its TypeScript source directly):

```text
your-workspace/
  cmd-backedges/     <- maze generation API
  vscode-backviews/  <- this extension
```

Build the extension:

```bash
cd vscode-backviews
npm install
npm run build

# Package to Install from VSIX
npm run pre:publish
```

**Output:**

```text
dist/extension.js   extension host bundle
media/webview.js    in-panel game bundle
```

To rebuild continuously while developing, use `npm run watch`. To regenerate `media/icon.png`
from the vector mark, use `npm run icons`.

## Getting Started

1. Open the `vscode-backviews` folder in VSCode.
2. Press `F5` (Run Extension). A new Extension Development Host window opens.
3. In that window, open the Command Palette (`Ctrl+Shift+P`) and run
   **BackViews: Enter the Backrooms**.
4. Click the panel to capture the mouse, and start walking.

**BackViews: Relocate (New Seed)** drops you into a fresh random seed when the current halls
start feeling too familiar. The same action is available from the in-game menu.

## Game Play

You wake up in an endless office interior. There is no exit; there is only further.

| Input | Action |
| --- | --- |
| `W` / `S` or `Up` / `Down` | Walk forward / back |
| `A` / `D` | Strafe left / right |
| `Left` / `Right` or `Q` / `E` | Turn |
| `Shift` | Hurry |
| Mouse (after clicking the view) | Look around |
| `M` or `Esc` | Open the menu |

Movement is camera-relative, and each axis (turn, strafe, forward/back) can be inverted from
the settings if your instincts run the other way.

Things to watch for while wandering:

- **Rooms, halls, and atriums.** Corridors occasionally open into blob-shaped rooms, rare
  rectangular halls with props, and very rare wide-open atriums with taller ceilings.
- **Random furniture.** Filing cabinets, abandoned desks, couches, moving boxes, and structural
  columns appear where the generator places props.
- **Wallpaper zones** (off by default; enable `backviews.wallpaperShifts`). Randomly shaped
  enclosed regions where the wallpaper shifts tint or pattern: an algorithm anchors wobbled
  radial blobs on a coarse lattice, and every cell inside a blob adopts that zone's palette.
  Crossing a boundary is how you know you have gone somewhere.
- **Doorways with depth.** Walls are slabs, not planes: openings show jamb faces on both sides
  and carry a header with a visible underside where a passage punches through a wall line.
- **Dead and flickering lights.** Some ceiling panels are out. Some should be.
- **The monster.** Sometime inside its spawn window it appears beyond the fog and starts
  closing in. It obeys the same walls you do, pathfinding through open passages only, so
  corners and long detours are survival tools. If it reaches you, the tape cuts to static and
  picks back up at the starting cell. It does not stop hunting; it only starts over. Turn it
  off in the settings for a quieter walk, or pick its body plan: spider-like, human-like,
  cloud-like, or a different form each spawn.

The in-game menu (press `M`) has Resume, **Relocate**, Settings, and Help, plus live stats:
current seed, cells visited, and generator cache size.

## Settings

All settings live under `backviews.*` in VSCode settings and are also editable live from the
in-game menu (menu changes persist back to your user settings).

| Setting | Default | Description |
| --- | --- | --- |
| `backviews.seed` | `0` | Maze seed; `0` picks a random seed per panel open |
| `backviews.moveSpeed` | `2.2` | Walking speed in cells per second |
| `backviews.renderDistance` | `14` | Meshed/drawn radius in cells |
| `backviews.cameraShake` | `true` | Handheld sway and walking head-bob |
| `backviews.filmGrain` | `true` | Grain, vignette, and tracking-noise overlay |
| `backviews.vhsHud` | `true` | REC dot, tape counter, battery, timestamp |
| `backviews.furniture` | `true` | Render generator-placed props |
| `backviews.wallpaperShifts` | `false` | Wallpaper zone tint/pattern changes |
| `backviews.mouseLook` | `true` | Pointer-lock mouse look on click |
| `backviews.invertTurn` | `false` | Flip turn direction (mouse and keys) |
| `backviews.invertStrafe` | `false` | Flip strafe left/right |
| `backviews.invertForward` | `false` | Flip forward/back |
| `backviews.materialPreset` | `classic` | Wall material set: `classic`, `office`, `pool`, `concrete`, `panel` |
| `backviews.materialHueShift` | `0` | Wall hue rotation in degrees, -180 to 180 |
| `backviews.materialBrightness` | `1` | Wall brightness multiplier, 0.6 to 1.4 |
| `backviews.monsterEnabled` | `true` | Something else walks these halls |
| `backviews.monsterSpeed` | `2.6` | Monster speed in cells per second |
| `backviews.monsterSpawnMin` | `1` | Earliest spawn, minutes after the world starts |
| `backviews.monsterSpawnMax` | `5` | Latest spawn, minutes after the world starts |
| `backviews.monsterForm` | `random` | Body plan: `spider`, `humanoid`, `cloud`, or `random` per spawn |

The material preset picks a pre-built wall set with one click, and the two sliders adjust its
adjustable elements: hue rotates the material's color cast around the wheel, and brightness
scales it lighter or darker.

### Photo materials

The `materials/` folder ships three photo textures that are tiled into the atlas when the
panel opens:

| File | Surface |
| --- | --- |
| `materials/wallpaper.jpg` | Walls (the `classic` preset papers every wall with it) |
| `materials/ceiling.jpg` | Ceiling tiles (the drop-ceiling grid is drawn back on top) |
| `materials/carpet.jpg` | Floor |

Swap any of these files to re-skin the game; if a file is missing or fails to load, that
surface falls back to its procedural texture. Wallpaper zones still recolor the photo
wallpaper and switch it to a darkened variant, and the hue/brightness sliders apply on top.

## API Quick Overview

The world is powered entirely by
[cmd-backedges](https://github.com/isocialPractice/cmd-backedges). The pieces this extension
consumes:

### `new MazeGenerator(config)`

Deterministic, infinite, memoized cell generation.

```ts
import { MazeGenerator } from 'cmd-backedges';

const generator = new MazeGenerator({ seed: 1234, depth: { min: 1.1, max: 1.6 } });
const cell = generator.getCell(0, 0);   // MazeCell: bounds, edges, dimensions, feature
generator.isPassable(0, 0, 'east');     // authoritative movement test
```

- `getCell(cx, cy)` returns the cell's footprint `bounds`, four `edges` (each `solid` or open,
  with start/end line segments), `dimensions` (including extrusion `depth`, used here as ceiling
  height), and an optional `feature` prop (column or furniture).
- Each edge carries `metadata` for 3D extrusion: `surfaceType` (mapped to wall materials),
  `materialSeed` (stable per-edge wear variation), heights, and thickness.
- `isPassable(cx, cy, direction)` drives the collision system, and doubles as the movement
  test for the monster's breadth-first pathfinding, so player and monster obey identical walls.

### `new MazeSession(generator)`

Discrete player tracking with events.

```ts
import { MazeSession } from 'cmd-backedges';

const session = new MazeSession(generator);
session.on('enterCell', (cell) => console.log('first visit', cell.cx, cell.cy));
session.move('east');
```

The renderer moves continuously, and keeps the session in sync cell-by-cell so `move`,
`blocked`, and `enterCell` events stay meaningful (visited-cell stats in the menu come from
`enterCell`).

### RNG helpers

`hashCoords`, `unitFromHash`, and `mulberry32` are reused for every deterministic visual the
renderer adds on top of the structure: light placement and health, wallpaper zone shapes and
palettes, furniture archetypes, and procedural texture noise.

> Note: the `cmd-backedges` package `main` field currently points at `dist/index.js`, but its
> compiled output lands at `dist/src/index.js`. This project sidesteps that by bundling from the
> library's TypeScript source via an esbuild alias (see `build.mjs`).

## Architecture

Two bundles from one TypeScript tree:

```text
src/
  extension.ts          Extension host: panel lifecycle, CSP, settings persistence
  shared/settings.ts    Settings shape + host/webview message protocol
  webview/
    main.ts             Frame loop, camera shake, flicker, host messaging
    world.ts            cmd-backedges -> geometry: chunk meshes, collision,
                        wallpaper zones, lights, furniture, material presets
    monster.ts          Spawn scheduling, BFS stalking, body-plan meshes
    renderer.ts         Raw WebGL: one shader, atlas texturing, fog, chunk
                        draws plus one dynamic mesh for the monster
    textures.ts         Procedural canvas texture atlas, patched at runtime
                        with the photo materials from materials/
    input.ts            Keyboard + pointer-lock mouse
    menu.ts             Pause menu / settings / help overlay
    film.ts             1990 camcorder overlay: grain, vignette, tears, HUD,
                        and the signal-lost static burst
```

Flow:

1. `extension.ts` opens a webview panel, injects `media/webview.js` under a strict CSP, and
   exchanges typed messages: `config` and `relocate` inbound, `ready` and `updateSetting`
   outbound.
2. `world.ts` wraps a `MazeGenerator` + `MazeSession` pair. As the player walks, 4x4-cell chunks
   inside the render distance are meshed (floor, ceiling, light panels, extruded solid edges,
   header bands where ceiling heights step down, and props) and uploaded; chunks out of range are
   disposed.
3. Everything decorative is a pure function of the seed and coordinates, matching the library's
   own philosophy: revisit any corridor and it looks exactly as you left it.
4. `renderer.ts` draws all chunks with a single shader: atlas tiles repeated via `fract()`,
   per-vertex baked lighting from nearby ceiling panels, exponential fog, and a global
   fluorescent flicker uniform. Emissive light-panel vertices skip scene lighting.
5. `monster.ts` sleeps until a randomized moment inside the spawn window, then walks the same
   passability grid as the player (breadth-first search toward the player's cell, recomputed as
   they move) and is rebuilt into the renderer's single dynamic mesh every frame.
6. `film.ts` layers the camcorder look on a 2D canvas so the 3D pass stays simple, and cuts the
   whole picture to static for a moment when the monster connects.

Since the maze, lights, zones, and props are all deterministic, the only state worth saving is
the seed and the player's position, which the webview persists across panel hides and reloads.

## LICENSE

MIT
