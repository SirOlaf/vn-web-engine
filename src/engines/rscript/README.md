# codeX RScript

Liar-soft's codeX RScript engine: GSC bytecode, XFL archives, WCG and LWG images, FSC
frame scripts and Vorbis ACM WAVE audio. The format readers live in
`src/formats/rscript`; this directory holds the interpreter, engine state and the
native game scene.

Each installation is identified by the `APINI` block compiled into its executable
(`apini.ts`); an `RsInit.cfg` beside the executable replaces it. The block supplies
the title, save prefix, resource directories, screen size, tick period and start
script, so titles sharing an engine revision need no per-game code. Do not select
behavior by a game's display name.

- `vm/` executes GSC programs. `layouts.ts` lists the operand layout of every
  opcode in the RScript 1.11.0.3 dispatcher; another engine revision should get its
  own layout table rather than edits to this one.
- `memory.ts` mirrors the native configuration block, scene state and variables.
  Save slots snapshot the scene state as a unit, so offsets must stay native.
- `runtime/` is the game scene: opcode handlers, layers, transitions, message
  boxes, the companion panel, backlog, choices, and the save, load and
  configuration screens built from the system LWG images.
- `graphics/` composites sprites in native pixel layout (B, G, R and a
  transparency byte) with the native blend modes.
- `browser/` adapts the scene to a canvas, Web Audio, fullscreen and a confirmation
  dialog. Other hosts implement `RScriptGameHost` in `runtime/game.ts`.

Native address comments refer to the Fairytale Requiem executable with SHA-256
`7c5392abef0810ec2ce3ec8c6318a566fce854281bbd52c7c032a8d7477ecd66` (RScript
1.11.0.3). They document recovered behavior, not address compatibility with other
builds.

`npm run verify:rscript -- "/path/to/game"` decodes every archive entry it
recognizes and reports counts and failures without writing assets.

## Known gaps

- The configuration screen's font button does nothing: the native font window lists
  installed fonts, which browsers cannot enumerate portably. Text uses the
  configured font name with Japanese fallbacks.
- Timed button and pointer waits do not draw their countdown gauge.
- The legacy top menu, text layers and native screens other than the title,
  configuration, save and load screens are reported as diagnostics. Fairytale
  Requiem uses none of them.
