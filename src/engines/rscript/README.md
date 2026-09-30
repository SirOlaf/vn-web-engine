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
- `browser/` adapts the scene to a canvas, Web Audio, fullscreen, a confirmation
  dialog and the selectable DOM text layer. Other hosts implement `RScriptGameHost` in `runtime/game.ts`.

Native address comments refer to the Fairytale Requiem executable with SHA-256
`7c5392abef0810ec2ce3ec8c6318a566fce854281bbd52c7c032a8d7477ecd66` (RScript
1.11.0.3). They document recovered behavior, not address compatibility with other
builds. The Fairytale Symphony and Fairytale Encore executables have identical code
and differ only in their `APINI` blocks and resources.

`npm run verify:rscript -- "/path/to/game"` decodes every archive entry it
recognizes and reports counts and failures without writing assets.

## Verification

- Fairytale Requiem was played to all twelve endings: both endings of each of the five heroine
  chapters, then both endings of the final chapter the title unlocks afterwards.
- Fairytale Symphony was played to both of its endings, and Fairytale Encore through all six
  scenarios, including the two the first four unlock.
- Screens were compared pixel by pixel with the native game at 1280x720:
  - title, scenes, maps, choices, backlog, the save, load and configuration screens
  - the library, room and sketchbook screens
  - colour-effect (sepia) scenes
- Slot saves load in both directions between the port and the native game.

A few diagnostics remain during play. Each names a file the game's own scripts request but its
archives do not contain, which the native game also fails to load. Examples are Fairytale
Requiem's `wav\4243.wav` and Fairytale Symphony's ending movie, which its installation lacks.

## Known gaps

- The font window lists fonts from the Local Font Access API by their OS/2 code page
  bits. GDI also offers Chinese fixed-pitch fonts such as NSimSun, which cover
  Shift-JIS without that bit; they are left out. Browsers without the API offer
  common Japanese fixed-pitch families they can draw.
- Timed button and pointer waits do not draw their countdown gauge.
- The legacy top menu, text layers and native screens other than the title,
  configuration, save and load screens are reported as diagnostics. Fairytale
  Requiem uses none of them.
