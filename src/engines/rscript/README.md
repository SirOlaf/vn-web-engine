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
- `browser/` adapts the scene to a canvas, Web Audio, the browser's fonts and the
  selectable DOM text layer. Message boxes, window activation and fullscreen come from
  `src/platform`; the page's display host decides what the configuration's screen mode
  does. Other hosts implement `RScriptGameHost` in `runtime/game.ts`.

Native address comments refer to the Fairytale Requiem executable with SHA-256
`7c5392abef0810ec2ce3ec8c6318a566fce854281bbd52c7c032a8d7477ecd66` (RScript
1.11.0.3). They document recovered behavior, not address compatibility with other
builds. The Fairytale Symphony and Fairytale Encore executables have identical code
and differ only in their `APINI` blocks and resources.

`npm run verify:rscript -- "/path/to/game"` decodes every archive entry it
recognizes and reports counts and failures without writing assets.

## Compatibility

| Title              | Executable SHA-256                                                 | Status                       |
| ------------------ | ------------------------------------------------------------------ | ---------------------------- |
| Fairytale Requiem  | `7c5392abef0810ec2ce3ec8c6318a566fce854281bbd52c7c032a8d7477ecd66` | Complete: all twelve endings |
| Fairytale Symphony | `adcc785a849606ffad8748645348392cbc28a44abc5f40f8180f30f81af89396` | Complete: both endings       |
| Fairytale Encore   | `04d1deb0eef007411d87d2d31f6652286f78b174ab190815d9bee58645a2ec49` | Complete: all six scenarios  |

All three are RScript 1.11.0.3. Scenes, maps, choices, backlog, colour effects and the save,
load, configuration and font screens match the native game pixel for pixel at 1280x720.
Slot saves are interchangeable with the native game.

Some diagnostics name files the game's own scripts request but its archives do not contain;
the native game fails to load them too. Examples are Fairytale Requiem's `wav\4243.wav` and
Fairytale Symphony's ending movie.

RScript 1.9 executables (for example Railsoft's Albatross Koukairoku) use an older `APINI` layout,
different operand layouts for opcodes 0x3E and 0x40, and LWG layer formats 40 and 56. They
are not supported.

## Known gaps

- The font window lists fonts from the Local Font Access API by their OS/2 code page
  bits. GDI also offers Chinese fixed-pitch fonts such as NSimSun, which cover
  Shift-JIS without that bit; they are left out. Browsers without the API offer
  common Japanese fixed-pitch families they can draw.
- Timed button and pointer waits do not draw their countdown gauge.
- The legacy top menu, text layers and native screens other than the title,
  configuration, save and load screens are reported as diagnostics. Fairytale
  Requiem uses none of them.
