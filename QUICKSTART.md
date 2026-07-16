# BackViews Quickstart ![BackViews icon](media/icon-docs.png)

Condensed from the [README](README.md). Full details, settings, API notes, and architecture
live there.

## Install

Needs VSCode 1.85+, Node 18+, and `cmd-backedges` checked out as a sibling folder.

```bash
cd vscode-backviews
npm install
npm run build
```

## Run

1. Open this folder in VSCode.
2. Press `F5` to launch the Extension Development Host.
3. Run **BackViews: Enter the Backrooms** from the Command Palette (`Ctrl+Shift+P`).

## Play

| Input | Action |
| --- | --- |
| `W` / `S` or `Up` / `Down` | Walk |
| `A` / `D` | Strafe |
| `Left` / `Right` or `Q` / `E` | Turn |
| `Shift` | Hurry |
| Click, then mouse | Look around |
| `M` or `Esc` | Menu (settings, relocate, help) |

Wander far enough and you will find rooms, rare halls with furniture, wallpaper zones where the
color shifts, and lights that no longer work. The same seed always rebuilds the same halls.

Something else spawns within a few minutes of starting and hunts through the same corridors.
Its speed, timing, form, and existence are all settings in the in-game menu.
