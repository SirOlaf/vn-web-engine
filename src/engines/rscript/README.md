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

- `revision.ts` describes each engine revision, selected by the executable's
  FileVersion: its `APINI` layout, opcode layouts, block sizes and the maps from 1.11
  offsets to its own. Executables of other revisions are rejected before launch.
- `vm/` executes GSC programs. `layouts.ts` lists the operand layout of every
  opcode in the RScript 1.11.0.3 dispatcher and the 1.9.0.0 table derived from it.
- `memory.ts` mirrors the native configuration block, scene state and variables.
  Save slots snapshot the scene state as a unit, so offsets must stay native.
  Accessors take 1.11 offsets (`Config`, `Scene`) and map them to the revision.
- `runtime/` is the game scene: opcode handlers, layers, transitions, message
  boxes, the companion panel, backlog, choices, and the save, load and
  configuration screens built from the system LWG images. `message-window.ts` is
  1.11's four-box window; `message-window-19.ts` is 1.9's page window with its
  settings panel and backlog scroll bars, and `characters.ts` its opcode 0xFF.
- `graphics/` composites sprites in native pixel layout (B, G, R and a
  transparency byte) with the native blend modes.
- `browser/` adapts the scene to a canvas, Web Audio, the browser's fonts and the
  selectable DOM text layer. Message boxes, window activation and fullscreen come from
  `src/platform`; the page's display host decides what the configuration's screen mode
  does. Other hosts implement `RScriptGameHost` in `runtime/game.ts`.

Native address comments refer to the Fairytale Requiem executable with SHA-256
`7c5392abef0810ec2ce3ec8c6318a566fce854281bbd52c7c032a8d7477ecd66` (RScript
1.11.0.3), unless they say 1.9: those refer to the Albatross Koukairoku executable with
SHA-256 `f04c9729c0f60269f6ffdc63ea71c587a2431c501ade698e374978050fd156c4` (RScript
1.9.0.0). They document recovered behavior, not address compatibility with other
builds. The Fairytale Symphony and Fairytale Encore executables have identical code
and differ only in their `APINI` blocks and resources.

`npm run verify:rscript -- "/path/to/game"` decodes every archive entry it
recognizes and reports counts and failures without writing assets.

## Compatibility

| Title                | Executable SHA-256                                                 | Status                       |
| -------------------- | ------------------------------------------------------------------ | ---------------------------- |
| Fairytale Requiem    | `7c5392abef0810ec2ce3ec8c6318a566fce854281bbd52c7c032a8d7477ecd66` | Complete: all twelve endings |
| Fairytale Symphony   | `adcc785a849606ffad8748645348392cbc28a44abc5f40f8180f30f81af89396` | Complete: both endings       |
| Fairytale Encore     | `04d1deb0eef007411d87d2d31f6652286f78b174ab190815d9bee58645a2ec49` | Complete: all six scenarios  |
| Albatross Koukairoku | `f04c9729c0f60269f6ffdc63ea71c587a2431c501ade698e374978050fd156c4` | Complete: all seven endings  |

The Fairytale titles are RScript 1.11.0.3. Scenes, maps, choices, backlog, colour effects and the save,
load, configuration and font screens match the native game pixel for pixel at 1280x720.
Slot saves are interchangeable with the native game.

Some diagnostics name files the game's own scripts request but its archives do not contain;
the native game fails to load them too. Examples are Fairytale Requiem's `wav\4243.wav` and
Fairytale Symphony's ending movie.

Albatross Koukairoku is RScript 1.9.0.0 at 800x600. Its message window
collects a page of messages in one full-screen box, written in columns or rows at the
size and placement chosen on the settings panel, and its characters come and go through
opcode 0xFF. Every story script runs: the three routes with both endings each, and the
stowaway route the title offers after them, with the CG, scene and music galleries.
The title, the opening chapters, the backlog, the configuration, save and load screens
and the galleries match the native game. Native system saves and slots load in the
browser, and slots and the system save written in the browser load in the native game.
Its archives lack `wav\2471.wav`, `wav\0103.wav` and the sprite `grpo_bu\1208`, which its
scripts request.

## Known gaps

- The font window lists fonts from the Local Font Access API by their OS/2 code page
  bits. GDI also offers Chinese fixed-pitch fonts such as NSimSun, which cover
  Shift-JIS without that bit; they are left out. Browsers without the API offer
  common Japanese fixed-pitch families they can draw.
- Timed button and pointer waits do not draw their countdown gauge.
- The configuration screen's `ex` option pages and `_test` sample buttons, and the 1.9
  slot text and image thumbnails, are not built; no supported title has their layers.
- The legacy top menu, text layers and native screens other than the title,
  configuration, save and load screens are reported as diagnostics. Fairytale
  Requiem uses none of them.
