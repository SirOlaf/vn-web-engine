# Agent instructions

This project reimplements Windows-native, often Windows-only, visual novel
engines on a pure web stack. The goals are compatibility and preservation: many
of these games crash or misbehave on other platforms. Native executables are
read for resources and evidence only; they never run in the browser.

## Current engines

| Engine        | Location               | Games                                                                 |
| ------------- | ---------------------- | --------------------------------------------------------------------- |
| BGI/Buriko    | `src/engines/buriko/`  | Aokana, 穢翼のユースティア, Jewelry Hearts Academia, Subarashiki Hibi |
| MAGES / SC3   | `src/engines/mages/`   | CHAOS;HEAD NOAH (`games/chaos-head-noah`)                             |
| codeX RScript | `src/engines/rscript/` | Fairytale Requiem, Fairytale Symphony, Fairytale Encore               |

BGI/Buriko is a complete recreation: `bp/` holds the bytecode VM, `native/`
the native services and script callbacks. codeX RScript runs GSC bytecode
(`vm/`) in a native game scene (`runtime/`). Read the engine `README.md` files
before changing an engine.

A browser tab has a small CPU budget. Compute-heavy routines are therefore
implemented in Rust compiled to WebAssembly (`wasm/`, rebuilt with
`npm run build:wasm`, output checked in) or moved to WebGL. This is the largest
intentional divergence from the native engines.

## Repository layout

- `src/platform/` – browser implementations of Windows/OS services (filesystem,
  registry, windows, mutexes, wallpaper, taskbar, drives, etc.).
- `src/audio`, `src/video`, `src/graphics`, `src/text`, `src/input` – shared
  media, rendering, font and input services.
- `src/core/` – binary readers, scheduling, worker and wasm helpers.
- `src/formats/` – format readers (archives, PE, Ogg, MPEG, PNG, BGI formats).
- `src/engines/` – engine interpreters. They do not select games.
- `ui/` – Svelte library/player/explorer pages, per-game compatibility profiles
  (`ui/game-profiles/`) and runtime wiring (`ui/runtimes/`).
- `tools/` – build, serve, verify, benchmark, probe and native-reconstruction
  tooling. `tools/native-lift/` has its own `AGENTS.md`.
- `docs/` – user and contributor documentation. `docs/tooling/README.md`
  describes the native evidence and lifting workflow.
- `tests/` – `node --test` suite (`tests/*.test.mjs`).
- `targetgame/`, `docs/investigations/`, `docs/reconstruction/` – local-only,
  ignored by git. Never commit game data or derived evidence dumps.

## Commands

```sh
npm run build          # svelte-check, runtime tsc, vite build into site/
npm test               # build, then run tests/*.test.mjs
npm run format:check   # prettier
npm start              # serve site/ on http://127.0.0.1:8000
npm run start:debug    # debug server
```

The `verify:*`, `benchmark-*`, and `probe-*` scripts under `tools/` cover
archive, media, VM and performance checks that the unit suite does not.

## Rules

### Platform abstractions

Before implementing a platform abstraction inside an engine, check whether it
already exists in the shared layers (`src/platform`, `src/audio`, `src/video`,
`src/graphics`, `src/text`, `src/input`, `src/core`). If it belongs there and
does not exist yet, add it there, not under the engine or game path.

Implement every native path fully, even when the browser cannot perform the
effect (for example changing the system wallpaper). The project-level
abstraction decides the outcome: do nothing, notify the user, or wire to the OS
in a host that allows it, such as an Electron build. Engine and game code must
not make that decision.

### Native fidelity

Follow native behavior closely unless doing so would clearly worsen the
experience. Preserve version differences explicitly; never select behavior by a
game's display name. Native addresses and evidence are tied to an exact
executable hash (see `src/engines/buriko/README.md` and
`docs/buriko-compatibility.md`).

### Testing

Test systems, not implementations. A one-to-one mapping of implementation files
to test files is excessive. Add tests where a system's behavior would otherwise
be unverified. The suite has known pre-existing failures; compare against a
baseline run rather than expecting a fully green run.

### Game assets

Never run visual checks that may display game assets (screenshots, rendered
frames, extracted images or video) unless the user has explicitly cleared that
content as safe. Many visual novels contain material that must not be viewed
automatically. Non-visual checks (logs, timings, hashes, control-flow probes
such as `tools/probe-buriko.mjs`) are fine.

### Documentation

Write explanatory documentation, never narrative. State what exists, how it
behaves, and where to begin contributing, not the history of how it was
achieved.
