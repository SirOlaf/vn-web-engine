# Kirikiri core (TVP)

The services and native classes of the Kirikiri Z core around the TJS2 runtime, following
krkrz `base/`, `utils/` and the reference build `nekopara_vol1.exe` (`../revision.ts`).

| File               | Contents                                                                   |
| ------------------ | -------------------------------------------------------------------------- |
| `kirikiri-core.ts` | `KirikiriCore`: configuration, preparation, class registration, start-up   |
| `storage.ts`       | Storage names, media, the `file` medium, XP3 archives, auto paths, streams |
| `streams.ts`       | `tTJSBinaryStream` over memory and over a file's fetched ranges            |
| `text-stream.ts`   | Text storages: encodings, cipher modes, compression                        |
| `log.ts`           | The core log, logging handlers, the log file                               |
| `plugins.ts`       | Plugin location, linking (`V2Link`) and unlinking                          |
| `classes/`         | `Storages`, `Scripts`, `Debug`, `Plugins`                                  |

## Using the core

```ts
const core = await KirikiriCore.create({
  executable, // nekopara_vol1.exe: selects the revision, message tables, exporter names
  executablePath: 'c:\\game\\nekopara_vol1.exe',
  uiLanguage: 0x0411,
  files, // KirikiriLocalFiles over the installation
  libraries: [NEKOPARA_VOL1_TPM, …], // plugin implementations (runtime wiring)
  clock,
});
await core.start();
```

The core installs the TJS2 VM (`../tjs2/vm/`) as `engine.executor`, with the compiler options of
its revision, the UI language's messages and the `-unaryaster=compat` and
`-evalcontext=global` options (`TVPInitScriptEngine`).

`create` reads what the native core reads synchronously at run time: the executable's message
tables (in the UI language) and exporter names, and the SHA-256 of every `.dll`/`.tpm` beside
the executable, in `system\` and in `plugin\` (plugin identities for the native library
loader). `start` follows the executable's start-up: project directory (`forcedataxp3(1)`:
`data.xp3` beside the executable, else abort), `.tpm` plugins in name order, then
`startup.tjs` as a suspendable top-level call.

Core classes are registered in the order of `TVPInitScriptEngine` (0x407010): Debug, Font,
Layer, Timer, AsyncTrigger, System, Storages, Plugins, VideoOverlay, Clipboard, Scripts, Rect,
Bitmap, ImageFunction, BitmapLayerTreeOwner, WaveSoundBuffer (with `PhaseVocoder`), Window
(with `BasicDrawDevice`). Implemented: Debug, Storages, Plugins, Scripts.

## Storage

Storage names are `media://domain/path`; `name.xp3>member` addresses a member of an archive
opened by the core. `StorageSystem.normalize` reproduces `TVPNormalizeStorageName`: Windows
names (`c:\…`, UNC) become `file:` names, `\` becomes `/`, omitted parts come from the
medium's current domain and path, the medium normalizes domain and path (`file` lower-cases
ASCII), `n` dots climb `n − 1` levels, duplicate slashes collapse.

Lookups are synchronous, as natively:

- the `file` medium answers existence and listings from `KirikiriLocalFiles`, an index of the
  installation;
- XP3 archives opened by the core keep their index in memory; the first stream opened from an
  archive loads it.

Opening a storage (`createStream`) returns a promise when bytes have to be fetched; callers
suspend on it. A stream over a large file reads only the ranges it has prefetched.

Auto paths (`addAutoPath`) build a table of storage names; a name listed by several paths
resolves to the last one, as `tTJSHashTable::Add` overwrites. `getPlacedPath` checks the
current directory first, then the table.

## Text storages

`readText` (`TVPCreateTextStreamForRead`) decodes, after an optional `oN` byte offset: UTF-16LE
with BOM; `FE FE` headers of mode 0/1 ciphered and mode 2 zlib-compressed UTF-16; UTF-8 with
BOM; otherwise the default read encoding, `UTF-8` unless `-readencoding` gives `Shift_JIS`
(the ANSI code page). `Scripts` uses its own `textEncoding` (default `UTF-8`). Text ends at the
first NUL. `openTextWrite` writes UTF-16LE with BOM, `c` (mode 1 cipher) and `z`
(compression). Compressed text is written as zlib stored blocks, which every zlib reader
accepts but which are larger than native output.

## Plugins

`Plugins.link(name)` locates the plugin like `tTVPPluginHolder` (storage first, then the
executable's folder, `system\`, `plugin\`), loads it through the native library loader and
calls `V2Link` with the function exporter. Plugins provide `TVP_PLUGIN`
(`src/native/tvp-plugin/contract.ts`). A located plugin without an implementation fails with
`UnsupportedPluginError`; the runtime decides how to report it. A plugin found inside an
archive is identified by the SHA-256 of its bytes, where the native core extracts it to a
temporary file.

The exporter implements the functions plugins of this title call. `has(signature)` answers
from the executable's exporter table (649 signatures). `suspend` lets a plugin's native
method wait for asynchronous work.

## Log

`TvpLog` keeps the last lines with their `HH:MM:SS` time (`Debug.getLastLog`), important lines
for the log file, and calls script logging handlers (`Debug.addLoggingHandler`); a handler that
fails is dropped. `startLogToFile` writes the important lines and the last 100 lines, then
every line, to `krkr.console.log` in the log location.

## Verification

- `tests/kirikiri-core.test.mjs`: name normalization, auto paths, text decoding, start-up on a
  synthetic installation with a CxDec archive and the tpm, `Storages`/`Scripts`/`Plugins`
  through TJS objects, `saveStruct` round trip.
- `tools/probe-kirikiri-core.mjs <game folder>` boots the core on an installation in Node and
  runs `startup.tjs` on the VM until it ends or stops at an error; it prints the core log, the
  linked plugins and the script blocks that ran. Non-visual.
