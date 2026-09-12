# VN Web Engine

VN Web Engine is an experimental, from-scratch visual novel runtime built entirely on the web platform. Its long-term goal is to support multiple native VN engines without flattening their differences into a single approximate runtime.

Development currently targets the MAGES engine. The first game implementation is **CHAOS;HEAD NOAH** for Windows (GOG), with complete opcode coverage across its 350 scripts and browser-native support for rendering, audio, movies, input, saves, and configuration.

The project does not include game assets. You must provide files from a legally obtained copy of the game.

## Project status

The CHAOS;HEAD NOAH implementation is feature-complete at the engine level and follows the native executable's behavior wherever it is game-specific. It includes:

- the SC3 script runtime and all opcodes used by the shipped scripts;
- title, story, configuration, save/load, backlog, TIPS, gallery, and music-room flows;
- CPK archives, CRILAYLA compression, PNG and WebP images, and MVL character meshes;
- streaming HCA audio and USM/MPEG-1 movie playback;
- native-style surfaces, masks, blend modes, shaders, particles, and scene effects;
- keyboard, mouse, touch, and fullscreen input;
- browser-persistent files, registry state, achievements, and native save formats;
- native atlas text or optional selectable DOM text; and
- an asset laboratory for inspecting the original archives.

Only CHAOS;HEAD NOAH is currently supported as a playable game. Shared MAGES components are intentionally limited to behavior demonstrated to be common across titles.

## Quick start

You need a recent Node.js installation with npm and an installed copy of CHAOS;HEAD NOAH.

```sh
npm ci
npm run build
npm start
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000), then use one of these methods:

1. Select **Choose game folder** and provide the installation folder containing `Game.exe` and `Data`. The files are read locally by your browser.
2. Place this repository inside the game installation, alongside `Game.exe` and the `Data` directory, then select **Open installed game**.

The automatic installation layout is:

```text
CHAOS HEAD NOAH/
├── Data/
│   └── *.cpk
├── Game.exe
└── web-engine/
```

`Game.exe` is used only as a resource container for the game's original cursors. Native executable code is never run by the browser engine.

## Game page

After the files are loaded, select **Play** to replace the launcher with the game canvas. The 1920×1080 output scales to the browser viewport while preserving its native aspect ratio.

A collapsible **Game options** panel floats over the page; the game itself is never placed inside it. The panel is available before launch and from supported native menu states, then hides during story playback and title transitions. It provides host-level controls for fullscreen, file selection, save transfer, and text rendering without replacing the game's own menus or input flow.

Game input follows the native player:

- use the keyboard or mouse as you would in the native release;
- tap to left-click on touchscreens;
- drag to move while holding the left button;
- hold for 500 ms or press with two fingers to right-click; and
- use the Game options panel for browser-level controls and save transfer.

Native atlas text provides the closest visual match. DOM text uses browser fonts while retaining the game's line breaks, making supported text selectable and accessible.

## Files, saves, and privacy

Game archives are read in bounded ranges and are not uploaded. The bundled server listens on loopback by default and serves files only from the expected installation and build paths.

Save data, configuration, registry values, and achievements are stored in browser-local IndexedDB, isolated by game and profile. The Game options panel supports the original `SAVEDATA.DAT`, `CONFIG.DAT`, and `PADCONFIG.DAT` formats. Import is available before play begins; existing files can also be exported as backups.

Browser storage belongs to the current browser origin and profile. Clearing site data removes it, so export important saves periodically.

To test from another device on your local network, run:

```sh
HOST=0.0.0.0 npm start
```

This exposes the original game archives to your LAN. Use it only on a trusted network.

## Asset laboratory

The [asset laboratory](assets.html) provides a separate interface for exploring the original archives. It can:

- preview PNG and WebP images;
- compose MVL character expressions;
- decode, play, seek, loop, and export HCA audio as WAV;
- stream USM movies with synchronized MPEG-1 video and HCA audio;
- inspect decompressed scripts and other binary assets; and
- run the game with additional diagnostic controls and a bounded instruction trace.

Like the game page, the laboratory reads local files without uploading them.

Its **Diagnostic player** embeds a development player in the laboratory viewer and exposes restart, fast-forward, status, and instruction-trace controls. Those debugging controls are not shown on the normal game page.

The [Aokana asset laboratory](aokana-assets.html) opens ARC20 archives from `targetgame/aokana` through the same local server, or from a selected game folder. Run `npm run build` and `npm start`, then open `/aokana-assets.html`.

It preserves duplicate archive entries and provides searchable, paginated browsing; BSE, DSC, SDC and legacy CompressedBG decoding; image RGB/alpha inspection and PNG export; BF_Movie frame seeking and playback with both alpha codecs; browser playback of Ogg Vorbis and MP4; font previews; and script, module, time-event, and binary inspection. Stored and decoded assets can be exported locally. Scripts are inspected, not executed. Browser media codec support determines Ogg/MP4 playback availability.

The native format implementations live in `src/formats/buriko`; asset routing and explorer presentation live in `src/engines/buriko`. No runtime dependencies or game assets are included. Run `node tools/verify-aokana.mjs` after building to decode the local corpus numerically, including every BF_Movie frame, without rendering or extracting assets.

## Architecture

The central design rule is simple: **only universally shared behavior belongs in a shared behavioral abstraction**. Engine-, game-, and platform-specific behavior stays on its native path, even when a broader abstraction would appear more convenient.

```text
src/
├── core/          Checked binary primitives and streaming byte sources
├── formats/       BURIKO, CRI, MPEG-1, PNG, and PE resource readers
├── audio/         PCM, HCA worker transport, and Web Audio playback
├── video/         Decoding workers, YUV frames, and WebGL presentation
├── graphics/      Surfaces, masks, meshes, blending, and draw submission
├── text/          Atlas and DOM text presentation
├── input/         Browser mouse, keyboard, and touch input
├── platform/      Filesystem, registry, storage, and achievements
└── engines/mages/
    ├── assets.ts  Shared MAGES asset identification and overlays
    ├── mvl.ts     Shared MVL character geometry
    └── games/
        └── chaos-head-noah/
            └── sc3/  The game's native runtime, opcodes, and presentation
```

The boundary is documented in [`src/engines/mages/README.md`](src/engines/mages/README.md).

The runtime has no production npm dependencies. TypeScript and Prettier are development dependencies.

## Development

Run the formatter and unit/integration suite before submitting changes:

```sh
npm run format
npm run format:check
npm test
```

Tests cover parsers, malformed inputs, state access, opcode control flow, rendering commands, storage, media synchronization, and browser input. Tests that use installed game data remain read-only.

Additional verification commands include:

```sh
npm run verify
npm run differential
npm run verify:audio
npm run verify:movies
npm run verify:characters
npm run verify:vm
```

`verify` checks archive structure and every stored span. `differential` compares every CRILAYLA result against an independent Python implementation. Media and VM verification commands exercise the installed archives more deeply. Native-comparison commands under the `compare:*` namespace may additionally require Python, FFmpeg, clang, and x86-64 execution support.

Current verification data covers 19 archives, 15,577 entries, 1,393 compressed entries, 12,436 HCA audio assets, 142 USM movies, 396 character pairs, and every opcode type present in the shipped scripts.

## Documentation

Not done yet

## Known limitations

- Other MAGES games do not yet have game adapters.
- The current automatic installation path targets the Windows GOG release of CHAOS;HEAD NOAH.
- Movie seeking decodes forward from the beginning and can be slow for long files.
- Selectable DOM text intentionally trades pixel-perfect glyph rendering for browser-native text.
- The narrow-screen interface and touch controls are implemented, but physical-device coverage remains limited.

## Legal

This is an unofficial compatibility project and is not affiliated with or endorsed by MAGES. Inc., Spike Chunsoft, or the game's publishers. CHAOS;HEAD NOAH and its assets belong to their respective owners. No copyrighted game data is included or required to be redistributed with this source tree.
