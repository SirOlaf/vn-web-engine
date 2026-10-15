# Kirikiri core (TVP)

The services and native classes of the Kirikiri Z core around the TJS2 runtime, following
krkrz `base/`, `utils/` and the reference build `nekopara_vol1.exe` (`../revision.ts`).

| File               | Contents                                                                     |
| ------------------ | ---------------------------------------------------------------------------- |
| `kirikiri-core.ts` | `KirikiriCore`: configuration, preparation, class registration, start-up     |
| `storage.ts`       | Storage names, media, the `file` medium, XP3 archives, auto paths, streams   |
| `streams.ts`       | `tTJSBinaryStream` over memory and over a file's fetched ranges              |
| `text-stream.ts`   | Text storages: encodings, cipher modes, compression                          |
| `log.ts`           | The core log, logging handlers, the log file                                 |
| `plugins.ts`       | Plugin location, linking (`V2Link`) and unlinking                            |
| `options.ts`       | Program arguments (embedded options, `.cf`/`.cfu` files) and the data path   |
| `events.ts`        | Event queue, delivery, continuous and compact events, uncaught errors        |
| `classes/`         | `Storages`, `Scripts`, `Debug`, `Plugins`, `System`, `Timer`, `AsyncTrigger` |

## Using the core

```ts
const core = await KirikiriCore.create({
  executable, // nekopara_vol1.exe: selects the revision, message tables, exporter names
  executablePath: 'c:\\game\\nekopara_vol1.exe',
  uiLanguage: 0x0411,
  files, // KirikiriLocalFiles over the installation
  libraries: [NEKOPARA_VOL1_TPM, …], // plugin implementations (runtime wiring)
  clock,
  commandLine: [], // arguments after the executable
  loop, // KirikiriMessageLoop: posted tasks, idle passes, timers
  system: {informationBox, readRegValue, …}, // KirikiriSystemPlatform services
  showError, // the error box of an uncaught script error
  onExit: (code) => core.shutdown(),
});
await core.start();
```

`start` resolves once the startup script has returned and events are being delivered, or
once the core has ended (`exitCode`). The host calls `shutdown` after `onExit`.

The core installs the TJS2 VM (`../tjs2/vm/`) as `engine.executor`, with the compiler options of
its revision, the UI language's messages and the `-unaryaster=compat` and
`-evalcontext=global` options (`TVPInitScriptEngine`).

`create` reads what the native core reads synchronously at run time: the executable's message
tables (in the UI language), exporter names and `TVPInitTJSScript` (the script of constants
such as `VK_*`, `gcsAuto`, `imageTagLayerType`), the configuration files, and the SHA-256 of
every `.dll`/`.tpm` beside the executable, in `system\` and in `plugin\` (plugin identities for
the native library loader). `start` follows the executable's start-up: project directory (`forcedataxp3(1)`:
`data.xp3` beside the executable, else abort), `.tpm` plugins in name order, then
`startup.tjs` as a suspendable top-level call.

Core classes are registered in the order of `TVPInitScriptEngine` (0x407010): Debug, Font,
Layer, Timer, AsyncTrigger, System, Storages, Plugins, VideoOverlay, Clipboard, Scripts, Rect,
Bitmap, ImageFunction, BitmapLayerTreeOwner, WaveSoundBuffer (with `PhaseVocoder`), Window
(with `BasicDrawDevice`). Implemented: Debug, Timer, AsyncTrigger, System, Storages, Plugins,
Scripts. `TVPInitTJSScript` runs before them.

## Program arguments and data path

`TVPInitProgramArgumentsAndDataPath`: arguments are looked up first-match in the order command
line, `<datapath>\<exe>.cfu`, `<exe>.cf`, the executable's embedded options (`TEXT` resource
139). Option lines are `name=value`; a quoted value is a TJS string literal
(`debugwin="\x6E\x6F"` is `no`). After a `--` argument every command-line argument becomes
`-argN`. `-datapath` (default `$(exepath)\savedata`) expands `$(exepath)`, `$(personalpath)`,
`$(appdatapath)`, `$(vistapath)` and `$(savedgamespath)`; the result is `System.dataPath` and the
log location. `System.setArgument` replaces the first match or inserts in front.

## Events

`TvpEventSystem` ports `EventIntf.cpp` and the win32 system control. Script events
(`postEvent`) wait in one queue with exclusive, normal and idle priorities and are delivered by
`deliverAllEvents`: exclusive events, then input events, then normal events posted before the
delivery started, then idle events, continuous handlers and window updates. Timers mark events
discardable, so none queue while events are disabled.

Deliveries are top-level calls (`runTopLevel`): one at a time, each to completion, including
suspensions in it. The host's `KirikiriMessageLoop` runs them: `post` for an
`invokeEvents` request, `every(50)` for the system watch timer (deliveries, a compact event
after 4 s without continuous handlers, a rehash every 1.5 s), and `idle` for one pass after
another while continuous handlers exist (the native busy idle loop; a browser paces it to
animation frames). With `-contfreq=N` a limiter requests continuous calls N times per second
instead. Natively a modal dialog runs a message loop in which events are delivered; here no
event is delivered while a call is suspended.

An error that escapes a delivery or the startup script is passed to `System.exceptionHandler`
(`TVP_CATCH_AND_SHOW_SCRIPT_EXCEPTION`, with the origin such as `event` or `startup` added to
the trace). Without a handler, or when it returns false, events are disabled, the log file is
started, the error is shown (`showError`) and the core exits with code 1. `System.exit` ends at
once (`TvpProcessExit` unwinds the call); `System.terminate` ends after the current call.

## System

`System` has the members of `SystemIntf.cpp` and the win32 `SystemImpl.cpp` except `exeBits`
and `osBits`, which the reference build lacks. Platform effects go through
`KirikiriSystemPlatform` (message box, registry, `ShellExecute`, key state, system colours,
screen metrics, named mutexes); absent services answer as a system without the feature. As in
the reference build, `osName` comes from `GetVersionEx` without a compatibility manifest
(`Windows 8 6.2.1008 `: the build number is masked with `0xfff`) and `platformName` is
always `Win32`. `inform`, `readRegValue` and `showVersion` suspend. `createAppLock` sees the
mutexes of the page (`PageWindowsNamedMutexes`). The graphic cache limit is clamped to a
system limit of 0 until the graphics loader keeps a cache.

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
- `tests/kirikiri-core-system.test.mjs`: option parsing and data path, `System` through
  scripts, uncaught errors and `System.exceptionHandler`, `AsyncTrigger`, `Timer`, continuous
  handlers, with a message loop and clock driven by the test.
- `tools/probe-kirikiri-core.mjs [--run <ms>] <game folder>` boots the core on an
  installation in Node, runs `startup.tjs` on the VM and delivers events for a while; it prints
  the core log, message boxes, the linked plugins, the script blocks that ran and the exit code.
  Non-visual.
