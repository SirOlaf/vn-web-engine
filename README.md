# VN Web Engine

A browser runtime for Windows visual novel engines. The source tree contains no game assets; use files from your own installation. Native game executables are read only for resources, never run in the browser.

## Supported games

| Game                                  | Engine      | Current state                                                                                  |
| ------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------- |
| CHAOS;HEAD NOAH (Windows GOG release) | MAGES / SC3 | Game runtime, menus, saves, audio, movies, and input implemented.                              |
| Aokana                                | BURIKO      | Loads and runs in the browser; native behavior and presentation are still being reconstructed. |

The games share browser services for files, storage, audio, video, graphics, and input. Game-specific behavior lives under `src/engines/`.

## Quick start

Install a recent Node.js version with npm, then run:

```sh
npm ci
npm run build
npm start
```

Open the [library](http://127.0.0.1:8000), select a game, and open its player. The library detects server-backed installations and manages browser save files. Each player can also choose an installation folder from the device. **Play** starts the loaded game. Direct player links: [Aokana](http://127.0.0.1:8000/aokana.html) and [CHAOS;HEAD NOAH](http://127.0.0.1:8000/noah.html).

- **CHAOS;HEAD NOAH:** Choose the installation folder containing `Game.exe` and `Data/*.cpk`. For **Open installed game**, put the installation files in `targetgame/chaos-head-noah/`, or point the server at the folder with `NOAH_DATA_ROOT="/path/to/CHAOS HEAD NOAH" npm start`.
- **Aokana:** Choose the game folder containing `system.arc`, the other root-level `.arc` files, `BGI.gdb`, and one game `.exe`. For **Open installed game**, put these files in `targetgame/aokana/`, or point the server at the folder with `AOKANA_DATA_ROOT="/path/to/Aokana" npm start`. The executable supplies the game's cursor resource.

Game files selected through the browser stay on your device. In server-backed mode, the server reads the installation files and serves the runtime data to connected browsers.
Both players offer **Add files** and **Add one file** when folder selection is unavailable or incomplete, and **Keep game files in browser** to save a complete installation locally before playing. Use **Open saved game files** on later visits. Folder handles read the original files on supporting browsers; iOS Safari may make a temporary copy. See [mobile files and audio](docs/mobile-compatibility.md) for browser limits, cache controls and audio recovery.
Ogg Vorbis playback uses a shared WebAssembly decoder to preserve native PCM boundaries and playback waits. Decoder-only WebKit comparisons lost boundary samples (4,109 → 3,981 frames for a synthetic stream; 64,892 → 64,832 for Aokana's `ASUKA` clip, with its first 128 samples missing). The fix decodes those samples without silence padding or timing changes; physical iPhone verification is still pending.
During Aokana startup, **Skip startup sequence** appears under **Game options → Playback**; select it again to stop skipping.
The Aokana library and player controls can import and export `BGI.gdb` and numbered `BGI*.cad` browser saves. Close the player before importing a save.

### HTTPS from another device

The local URL above is a browser secure context because it uses loopback. Ordinary `http://` from another device is not: AudioWorklet may be unavailable, causing audio to use a slower compatibility path or fail if that path is unsupported. Use HTTPS when playing remotely. With [Tailscale Serve](https://tailscale.com/docs/reference/examples/serve), keep `npm start` running on the game host and, in another terminal there, run:

```sh
tailscale serve 8000
```

Open the HTTPS URL printed by Tailscale on a device in the same tailnet, adding `/aokana.html` if desired. Tailscale Serve proxies the server's existing loopback port; `HOST=0.0.0.0` is not needed. An HTTPS reverse proxy to `127.0.0.1:8000` works too. Tailscale Serve may prompt you to enable HTTPS certificates for your tailnet.

WebAssembly support is required for the shared Vorbis decoder. Some optional acceleration modules have JavaScript fallbacks, which may be much slower; the viewer reports audio and WebAssembly fallbacks when they occur.

## Saves and tools

Browser saves and settings are stored in IndexedDB for the current origin and browser profile. Clearing site data removes them. The viewer provides save import and export for CHAOS;HEAD NOAH.

The [CHAOS;HEAD NOAH asset laboratory](assets.html) and [Aokana asset laboratory](aokana-assets.html) are separate inspection tools.

## Development

```sh
npm run format:check
npm test
```

`npm test` builds and runs the unit and integration suite. Additional archive, media, and VM checks are available through the `verify:*` scripts in [package.json](package.json). The [native reconstruction tooling](docs/tooling/README.md) has its own workflow. Optional embedded WebAssembly kernels are checked into the source; edit their Rust sources and run `npm run build:wasm` only when rebuilding them.

## Legal

This is an unofficial compatibility and preservation project, unaffiliated with the games' developers or publishers. Game files are not included and should not be redistributed with this source tree.
The bundled Vorbis decoder's dependency attribution and notices are in [third_party/ogg-vorbis](third_party/ogg-vorbis/README.md); the build also distributes them with the decoder.
