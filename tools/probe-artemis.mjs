/** Nonvisual diagnostics of the Artemis runtime over actual memory asset/PCM providers. No
 * native game process, picture output or audio-device output. */
import {createHash} from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  writeSync,
  closeSync,
} from 'node:fs';
import {createArtemisShaderFixture} from './artemis-shader-fixture.mjs';
import {createArtemisSurfacePreloadFixture} from './artemis-surface-preload-fixture.mjs';
import {createArtemisGlyphLayoutFixture} from './artemis-glyph-layout-fixture.mjs';
import {createArtemisOfflineSoundFixture} from './artemis-offline-sound-fixture.mjs';
import {createMetadataLayerFixture} from './artemis-metadata-layer-fixture.mjs';
import {openArtemisInstallation} from './artemis-installation.mjs';
import {BrowserWindowsSystemProfileHost} from '../dist/platform/browser-windows-system-profile.js';
import {BrowserWindowsProcessHost} from '../dist/platform/browser-windows-process.js';
import {BrowserWindowsDynamicLibraryHost} from '../dist/platform/windows-dynamic-library.js';
import {BrowserWindowsFolderPaths} from '../dist/platform/windows-folder-path.js';
import {FetchHttpClient} from '../dist/platform/http-client.js';
import {packArtemisSaveFile} from '../dist/formats/artemis/save-file.js';
import {readAsfHeader} from '../dist/formats/asf/header.js';
import {ArtemisRuntime} from '../dist/engines/artemis/runtime.js';
import {artemisInteger} from '../dist/engines/artemis/numbers.js';
import {artemisRevision} from '../dist/engines/artemis/revision.js';
import {luaText} from '../dist/core/lua51/runtime.js';
if (!process.argv[2]) throw new Error('Usage: node tools/probe-artemis.mjs GAME_DIRECTORY');
const dialogResultArgument = process.argv
  .slice(3)
  .find((value) => value.startsWith('--dialog-result='));
const simulatedDialogResult = dialogResultArgument
  ? Number(dialogResultArgument.split('=')[1])
  : null;
if (simulatedDialogResult !== null && ![0, 1].includes(simulatedDialogResult))
  throw new Error('Probe dialog result must be 0 or 1');
const httpCancelArgument = process.argv.find((value) =>
  value.startsWith('--http-cancel-after-ms='),
);
const httpCancelAfter = httpCancelArgument ? Number(httpCancelArgument.split('=')[1]) : null;
if (httpCancelAfter !== null && (!Number.isFinite(httpCancelAfter) || httpCancelAfter < 0))
  throw Error('Probe HTTP cancellation delay must be nonnegative');
const advanceWaits = process.argv.slice(3).includes('--advance-waits');
const nativeIncludeReporting = process.argv.slice(3).includes('--native-include-reporting');
// --native-load-reporting: missing images and layers are recorded (metadataLayerFixture
// failures) like the native script error reports, and the game continues.
const nativeLoadReporting = process.argv.slice(3).includes('--native-load-reporting');
const nativeCallLuaReporting = process.argv.slice(3).includes('--native-calllua-reporting');
// SIMULATED --screenshots: takess is recorded and savess reads zero-filled RGBA rows; no
// scene is rendered.
const simulatedScreenshots = process.argv.slice(3).includes('--screenshots');
let screenshotTaken = false;
// Diagnostic layer events (--layer-event=id[:type], type defaults to click) and pushed
// keys (--key-push=key, slot 0 edge) at a run mode 3 stop, one per frame in argument order.
// No pointer hit testing is simulated.
const probeInputs = process.argv
  .slice(3)
  .filter((arg) => arg.startsWith('--layer-event=') || arg.startsWith('--key-push='))
  .map((arg) => {
    if (arg.startsWith('--key-push='))
      return {key: artemisInteger(arg.slice('--key-push='.length))};
    const [id, type = 'click'] = arg.slice('--layer-event='.length).split(':');
    return {id, type};
  });
// --layer-event-at=N:id[:type] and --key-push-at=N:key (repeatable, argument order): before
// the Nth delivered click, raise the layer event (type defaults to click) or push the key
// (slot 0 edge) at the click-wait instead, one per frame. --stop-event-at=N:id[:type] and
// --stop-key-at=N:key wait instead for run mode 3 without a pending wait after at least N
// delivered clicks (game dialogs and menus stop the script). --press-at=N:id instead runs
// real runtime frames like a browser pointer press once the text display completes: the
// pointer rests on the layer for 30 frames, one frame samples key 1 down and 30 frames
// release it. No pointer hit testing.
const timedPrefixes = [
  '--layer-event-at=',
  '--key-push-at=',
  '--stop-event-at=',
  '--stop-key-at=',
  '--press-at=',
];
const timedInputs = process.argv
  .slice(3)
  .filter((arg) => timedPrefixes.some((prefix) => arg.startsWith(prefix)))
  .map((arg) => {
    const stop = arg.startsWith('--stop-');
    const [at, ...rest] = arg.slice(arg.indexOf('=') + 1).split(':');
    if (arg.startsWith('--key-push-at=') || arg.startsWith('--stop-key-at='))
      return {at: artemisInteger(at), key: artemisInteger(rest[0]), stop};
    const [id, type = arg.startsWith('--press-at=') ? 'press' : 'click'] = rest;
    return {at: artemisInteger(at), id, type, stop};
  });
// Diagnostic clicks (--clicks=N) at `@` click-waits: 16 ms frames run until the text
// display completes, then one run mode 1 click is delivered. No pointer position is used.
// The last --clicks argument wins.
const clickArgument = process.argv.slice(3).findLast((arg) => arg.startsWith('--clicks='));
let probeClicks = clickArgument ? artemisInteger(clickArgument.slice('--clicks='.length)) : 0;
// --save-load-at=N: before the Nth delivered click, save a scenario file and load it; the
// loaded state must match the saved one (see the Artemis README).
const saveLoadArgument = process.argv.slice(3).findLast((arg) => arg.startsWith('--save-load-at='));
const saveLoadAt = saveLoadArgument
  ? artemisInteger(saveLoadArgument.slice('--save-load-at='.length))
  : null;
// --auto-choice=PREFIX (repeatable) with --auto-choices=N: once the scripted inputs are used
// up at a run mode 3 stop, pick the first visible layer with an enabled click event whose id
// starts with a prefix (prefix order, then native child order) and press it like a browser
// pointer (see --press-at), at most N times. A diagnostic route policy, not player input.
const autoChoicePrefixes = process.argv
  .slice(3)
  .filter((arg) => arg.startsWith('--auto-choice='))
  .map((arg) => arg.slice('--auto-choice='.length));
const autoChoicesArgument = process.argv
  .slice(3)
  .findLast((arg) => arg.startsWith('--auto-choices='));
let autoChoices = autoChoicesArgument
  ? artemisInteger(autoChoicesArgument.slice('--auto-choices='.length))
  : 0;
const autoChoiceLog = [];
// --automode-limit=N: once automode has ended N click-waits, the next click-wait receives one
// browser pointer press on no layer (see --press-at), the input automode's stop-by-click role
// reads; the report's automodeStop records whether automode ended.
const automodeLimitArgument = process.argv
  .slice(3)
  .findLast((arg) => arg.startsWith('--automode-limit='));
const automodeLimit = automodeLimitArgument
  ? artemisInteger(automodeLimitArgument.slice('--automode-limit='.length))
  : null;
// --lua-memory-every=N: every N delivered clicks, record the Lua heap (collectgarbage
// "count", KiB) and the Lua module's wasm memory size in bytes. Diagnostic only.
const luaMemoryArgument = process.argv
  .slice(3)
  .findLast((arg) => arg.startsWith('--lua-memory-every='));
const luaMemoryEvery = luaMemoryArgument
  ? artemisInteger(luaMemoryArgument.slice('--lua-memory-every='.length))
  : 0;
const luaMemory = [];
const shaderPresets = process.argv.slice(3).includes('--shader-presets');
// --windows-version=MAJOR.MINOR: the SIMULATED Windows version (the browser page reports
// 10.0); absent, the query fails like the browser system profile.
const windowsVersionArgument = process.argv
  .slice(3)
  .findLast((arg) => arg.startsWith('--windows-version='))
  ?.slice('--windows-version='.length);
const simulatedWindowsVersion =
  windowsVersionArgument === undefined
    ? null
    : (() => {
        const match = /^(\d+)\.(\d+)$/.exec(windowsVersionArgument);
        if (!match) throw new Error('Probe Windows version must be MAJOR.MINOR');
        return {major: Number(match[1]), minor: Number(match[2])};
      })();
const astCheck = process.argv
  .slice(3)
  .findLast((arg) => arg.startsWith('--ast-check='))
  ?.slice('--ast-check='.length);
const graphicsFeatureArgument = process.argv
  .slice(3)
  .find((value) => value.startsWith('--graphics-feature-level='));
const simulatedGraphicsFeatureLevel =
  graphicsFeatureArgument === undefined ? null : Number(graphicsFeatureArgument.split('=')[1]);
let resourceResumptions = 0,
  advancedWaits = 0;
const saveFiles = new Map();
// --save-dir=DIR: the save directory starts with DIR's files and is written back to DIR at
// the end, so a later run continues from this run's global and system data.
const saveDir = process.argv
  .slice(3)
  .findLast((arg) => arg.startsWith('--save-dir='))
  ?.slice('--save-dir='.length);
// A fresh process boots normally to its first native stop, then loads an own/copied
// scenario save through the real loader. Capture occurs before the game's onLoad.
const startSaveFile = process.argv
  .slice(3)
  .findLast((arg) => arg.startsWith('--start-save='))
  ?.slice('--start-save='.length);
const expectedStartSha256 = process.argv
  .slice(3)
  .findLast((arg) => arg.startsWith('--expected-start-sha256='))
  ?.slice('--expected-start-sha256='.length);
if (
  startSaveFile !== undefined &&
  (saveDir === undefined || !startSaveFile || /[\\/\0]/.test(startSaveFile))
)
  throw Error('Probe start-save requires a basename and an explicit save-dir');
if (
  expectedStartSha256 !== undefined &&
  (startSaveFile === undefined || !/^[0-9a-f]{64}$/.test(expectedStartSha256))
)
  throw Error('Probe expected-start-sha256 requires start-save and a SHA-256');
if (saveDir !== undefined) {
  mkdirSync(saveDir, {recursive: true});
  for (const name of readdirSync(saveDir)) saveFiles.set(name, readFileSync(`${saveDir}/${name}`));
}
// --report-dir=DIR: every array in the report, or in one of its objects, longer than 10000
// entries is written to DIR/<key>.ndjson (DIR/<key>.<field>.ndjson), one entry per line, and
// the report (also DIR/report.json) names the file in its place.
// Nothing is dropped, and the report never becomes one string past the engine limit.
const reportDir = process.argv
  .slice(3)
  .findLast((arg) => arg.startsWith('--report-dir='))
  ?.slice('--report-dir='.length);
const reportText = (report) => {
  if (reportDir === undefined) return JSON.stringify(report, null, 2);
  mkdirSync(reportDir, {recursive: true});
  const stream = (name, value) => {
    const fd = openSync(`${reportDir}/${name}.ndjson`, 'w');
    try {
      for (let start = 0; start < value.length; start += 10000)
        writeSync(
          fd,
          value
            .slice(start, start + 10000)
            .map((entry) => JSON.stringify(entry) + '\n')
            .join(''),
        );
    } finally {
      closeSync(fd);
    }
    return {ndjson: `${name}.ndjson`, length: value.length};
  };
  const large = (value) => Array.isArray(value) && value.length > 10000;
  const summary = {};
  for (const [key, value] of Object.entries(report)) {
    if (large(value)) summary[key] = stream(key, value);
    else if (value && typeof value === 'object' && !Array.isArray(value))
      summary[key] = Object.fromEntries(
        Object.entries(value).map(([field, item]) => [
          field,
          large(item) ? stream(`${key}.${field}`, item) : item,
        ]),
      );
    else summary[key] = value;
  }
  const text = JSON.stringify(summary, null, 2);
  writeFileSync(`${reportDir}/report.json`, text);
  return text;
};
const installation = await openArtemisInstallation(process.argv[2]);
let runtime, glyphFixture, surfaceFixture, soundFixture, shaderFixture, layerFixture;
try {
  const events = [],
    nativeTags = [],
    includes = [],
    luaIncludeErrors = [],
    luaCallErrors = [],
    unknownTagReports = [],
    tagErrorReports = [],
    modeEffects = [],
    dialogs = [];
  // Like the browser player: the root executable whose hash names a supported revision
  // (installations also ship updaters and other executables).
  const executableHashes = [];
  for (const path of installation.paths) {
    if (!/\.exe$/i.test(path) || path.includes('/')) continue;
    const executable = await installation.files.read(path);
    if (executable === null) throw new Error('Missing Artemis executable');
    const hash = createHash('sha256').update(executable).digest('hex');
    try {
      artemisRevision(hash);
      executableHashes.push(hash);
    } catch {
      // Not an Artemis executable of a supported revision.
    }
  }
  if (executableHashes.length !== 1)
    throw new Error('Probe requires exactly one supported root executable');
  const [executableSha256] = executableHashes;
  // Save directory paths read the probe's save storage, like the browser player.
  const read = (path) => runtime?.readSaveDirectoryFile(path) ?? installation.files.read(path);
  glyphFixture = createArtemisGlyphLayoutFixture(executableSha256, read);
  surfaceFixture = createArtemisSurfacePreloadFixture(executableSha256, read);
  soundFixture = createArtemisOfflineSoundFixture(executableSha256, read);
  if (shaderPresets) shaderFixture = createArtemisShaderFixture(executableSha256, read);
  const systemProfile = new BrowserWindowsSystemProfileHost();
  const processHost = new BrowserWindowsProcessHost();
  // SIMULATED device: a fullscreen movie plays for its ASF header duration in probe ticks;
  // no media is decoded or shown. No input arrives while it plays.
  const moviePlayer = {
    end: null,
    get playing() {
      return this.end !== null && runtime.now < this.end;
    },
    async play(request) {
      const bytes = await installation.files.readPlain(request.path);
      if (!bytes) return false;
      const header = readAsfHeader(bytes);
      if (header.duration === null) throw Error('Probe fullscreen movie has no duration');
      this.end = runtime.now + Math.ceil(header.duration);
      modeEffects.push({
        fullscreenVideo: request,
        bytes: bytes.length,
        duration: header.duration,
        simulation: true,
      });
      return true;
    },
    close() {
      this.end = null;
    },
  };
  runtime = await ArtemisRuntime.open({
    executableSha256,
    files: {
      read,
      readPlain: (path) => installation.files.readPlain(path),
      resolvePath: (path) => installation.files.resolvePath(path),
      setMagicPath: (name, root) => installation.files.setMagicPath(name, root),
      paths: installation.paths,
    },
    // SIMULATED storage: files written during this probe run stay in memory.
    storage: {
      read: async (name) => saveFiles.get(name) ?? null,
      write: (name, bytes) => void saveFiles.set(name, bytes),
      delete: (name) => void saveFiles.delete(name),
    },
    // SIMULATED seed: a fixed Unix time keeps probe runs deterministic.
    randomSeed: 1733961600,
    createLayers: (host) =>
      (layerFixture = createMetadataLayerFixture(
        executableSha256,
        read,
        host,
        nativeLoadReporting,
        // The failing tag is the last traced one (layer tags trace before dispatch).
        () => ({tagIndex: nativeTags.length - 1}),
      )),
    glyphs: glyphFixture,
    surfaces: surfaceFixture.manager,
    sound: soundFixture,
    ...(shaderFixture ? {shaders: shaderFixture} : {}),
    moviePlayer,
    ...(simulatedScreenshots
      ? {
          screenshots: {
            take: () => {
              screenshotTaken = true;
              modeEffects.push({takess: true, simulation: true});
            },
            takePresented: () => {
              screenshotTaken = true;
              modeEffects.push({takess: 'presented', simulation: true});
            },
            read: (width, height) => (screenshotTaken ? new Uint8Array(width * height * 4) : null),
          },
        }
      : {}),
    dialogs: {
      present: (request, complete) => {
        dialogs.push(request);
        // SIMULATED text fields keep their initial text.
        if (simulatedDialogResult !== null)
          complete({result: simulatedDialogResult, text: request.message});
      },
    },
    http: new FetchHttpClient(),
    window: {
      minimized: () => false,
      show: (command) => modeEffects.push({windowShow: command, simulation: true}),
      toggleFullscreen: () => modeEffects.push({toggleFullscreen: true, simulation: true}),
      displayModeChanged: () => modeEffects.push({displayModeChanged: true, simulation: true}),
    },
    caption: {
      setCaption: (title) => {
        modeEffects.push({windowCaption: title, simulation: true});
        return true;
      },
    },
    cursor: {
      setVisible: (visible) => modeEffects.push({cursorVisible: visible}),
      setPosition: (left, top) => modeEffects.push({cursorPosition: {left, top}}),
    },
    pointer: {readPointerPosition: () => ({x: 0, y: 0})},
    dynamicLibraries: new BrowserWindowsDynamicLibraryHost(),
    folderPaths: new BrowserWindowsFolderPaths(),
    windowsVersion: () => simulatedWindowsVersion ?? systemProfile.readVersion(),
    // As a page without (or denied) Local Font Access: no installed faces.
    fontFamilies: async () => [],
    // The browser platform: no command interpreter, no process environment.
    luaOs: {
      system: (command) => processHost.system(command),
      getenv: (name) => systemProfile.readEnvironmentVariable(name),
    },
    ...(simulatedGraphicsFeatureLevel === null
      ? {}
      : {graphicsFeatureLevel: () => simulatedGraphicsFeatureLevel}),
    applyVolumes: (music, effect) => modeEffects.push({volumes: {music, effect}, simulation: true}),
    setTouchLimit: (limit) => modeEffects.push({touchLimit: limit}),
    ...(nativeIncludeReporting
      ? {
          reportIncludeError: (path, error) => {
            const message = error instanceof Error ? error.message : String(error);
            luaIncludeErrors.push({path, message, severity: 1});
            // Preserve explicit host capability/resource guards in this diagnostic.
            if (/Unsupported|not implemented|not prepared|budget|cancelled|requires/i.test(message))
              throw error;
          },
        }
      : {}),
    // Diagnostic record of native c84b0 severity1 reports; no debug console/LogFilter policy.
    ...(nativeCallLuaReporting
      ? {
          reportLuaCallError: ({file, tag, message, severity}) =>
            luaCallErrors.push({
              file,
              sourceLine: tag.sourceLine,
              function: tag.args.get('function'),
              message: new TextDecoder().decode(message),
              severity,
            }),
          // Tag owner reports (c7260 severity 1); the tag returns normally.
          reportTagError: ({file, tag, message, severity}) =>
            tagErrorReports.push({
              file,
              sourceLine: tag.sourceLine,
              name: tag.name,
              args: Object.fromEntries(tag.args),
              message: new TextDecoder('shift_jis').decode(message),
              severity,
            }),
          // c5800 unknown command/macro report (c7260 severity 1); the tag returns normally.
          reportUnknownTag: ({file, tag, message, severity}) =>
            unknownTagReports.push({
              file,
              sourceLine: tag.sourceLine,
              name: tag.name,
              args: Object.fromEntries(tag.args),
              message: new TextDecoder('shift_jis').decode(message),
              severity,
            }),
        }
      : {}),
    reportError: (message) =>
      luaCallErrors.push({
        engineMethod: true,
        message: new TextDecoder('shift_jis').decode(message),
        severity: 1,
      }),
    trace: {
      // Each native tag with the delivered clicks before it, to place tags on a route.
      tag: (tag) =>
        nativeTags.push({
          name: tag.name,
          args: Object.fromEntries(tag.args),
          click: deliveredClicks,
        }),
      script: (entry) => events.push(entry),
      include: (path) => includes.push(path),
      effect: (effect) => modeEffects.push(effect),
    },
  });
  const {script, wait, lua} = runtime;
  let deliveredClicks = 0,
    saveLoadReport = null,
    startSaveLoadReport = null,
    captureLoaded = false,
    loadedArchive = null;
  // The round trip compares the state the loader restored, before `onLoad` runs.
  runtime.scenarioLoaded = () => {
    if (captureLoaded) loadedArchive = runtime.scenarioArchive();
  };
  const loadFile = async (file) => {
    captureLoaded = true;
    loadedArchive = null;
    try {
      if (!(await runtime.load.load(file, true))) throw Error('Probe scenario load failed');
    } finally {
      captureLoaded = false;
    }
    if (!loadedArchive) throw Error('Probe scenario load did not run the scenario loader');
    if (wait.pending || script.state !== 'ready')
      throw Error('Probe scenario load did not resume the restored caret');
    return loadedArchive;
  };
  const saveLoadRoundTrip = async () => {
    const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
    // A caret saved inside a wait loads at the same tag in run mode 0 with its wait flags
    // clear, so the first load changes the caret. Loading the archive of that loaded state
    // must restore it unchanged. Each load then runs the game's `onLoad` handler.
    runtime.save.request('probe-roundtrip.dat', true, true);
    await runtime.flushSaves();
    // After the save, which ran the game's `onSave` handler first.
    const before = runtime.scenarioArchive();
    const expected = runtime.scenarioArchive(true);
    const loaded = await loadFile('probe-roundtrip.dat');
    saveFiles.set('probe-roundtrip-2.dat', await packArtemisSaveFile('S', loaded));
    const reloaded = await loadFile('probe-roundtrip-2.dat');
    saveLoadReport = {
      click: deliveredClicks,
      archiveBytes: before.length,
      saved: hash(before),
      loaded: hash(loaded),
      reloaded: hash(reloaded),
      restored: hash(loaded) === hash(expected),
      stable: hash(loaded) === hash(reloaded),
      runMode: runtime.runMode,
      callDepth: script.callDepth,
      files: ['probe-roundtrip.dat', 'probe-roundtrip-2.dat'],
    };
    if (!saveLoadReport.restored || !saveLoadReport.stable) {
      // The archives are kept for a structural comparison of the differing fields.
      if (reportDir !== undefined) {
        mkdirSync(reportDir, {recursive: true});
        writeFileSync(`${reportDir}/roundtrip-expected.bin`, expected);
        writeFileSync(`${reportDir}/roundtrip-loaded.bin`, loaded);
        writeFileSync(`${reportDir}/roundtrip-reloaded.bin`, reloaded);
      }
      throw Error('Probe scenario save/load round trip differs');
    }
  };
  // Deterministic 16 ms frame.
  const frame = () => runtime.advanceTo((runtime.now + 16) >>> 0 || 1);
  // A browser pointer press on a layer, as ArtemisBrowserPlayer delivers it: the pointer moves
  // onto the layer and rests there for 30 16 ms frames (half a second), then one frame samples
  // key 1 down and the pointer stays on the layer for 30 more frames. The press is raised in
  // the next update. Each frame runs the script itself; pending resources settle before the
  // next frame, as in the browser. Game Lua records a button click in its click handler and
  // acts on it in the key push handler that runs after it.
  const pointerPress = async (id) => {
    for (let count = -30; count < 31; count++) {
      const now = (runtime.now + 16) >>> 0 || 1;
      runtime.frame(now, {
        sample: {down: new Set(count ? [] : [1]), pointerInside: true},
        pointer: {x: 0, y: 0, hits: id === null ? [] : [id]},
      });
      while (runtime.resourcePending) {
        await runtime.settleResource();
        resourceResumptions++;
      }
    }
  };
  // Durations of click-waits that automode ended, in milliseconds.
  const automodeWaits = [];
  const httpWaits = [];
  let automodeStop = null;
  let refusal = null;
  try {
    await runtime.boot();
    let readySlices = 0;
    while (script.state === 'waiting' || script.state === 'ready') {
      if (script.state === 'ready') {
        // A slice that used up its step budget leaves the script ready.
        if (++readySlices >= 10000000) throw Error('Probe script slice budget exceeded');
        script.run(1000);
        continue;
      }
      if (runtime.resourcePending) {
        if (resourceResumptions >= 10000000) throw Error('Probe resource budget exceeded');
        const settled = await runtime.settleResource();
        resourceResumptions++;
        if (settled === 'held') continue;
        // Native loads resources synchronously inside the tag or Lua call; the frame that
        // advances sound and delivers its finish events runs only once the script settles.
        if (!runtime.resourcePending) {
          runtime.advanceTo((runtime.now + 1) >>> 0);
          if (script.state === 'ready') script.run(1000);
        }
        continue;
      }
      if (advanceWaits && runtime.layers.transitionPending && advancedWaits < 1000000) {
        runtime.advanceTo(runtime.layers.finishTransition((runtime.now + 1) >>> 0 || 1));
        advancedWaits++;
        script.run(1000);
        continue;
      }
      if (advanceWaits && runtime.layers.tweenSyncPending && advancedWaits < 1000000) {
        // Deterministic 16 ms frames until the sync tween's completion ends run mode 4.
        for (let count = 0; runtime.layers.tweenSyncPending; count++) {
          if (count >= 100000) throw Error('Probe sync tween did not finish');
          frame();
        }
        advancedWaits++;
        script.run(1000);
        continue;
      }
      if (runtime.runMode === 7) {
        // Deterministic 16 ms frames of run mode 7 until the movie ends.
        for (let count = 0; runtime.runMode === 7; count++) {
          if (count >= 10000000) throw Error('Probe fullscreen video did not finish');
          frame();
          runtime.fullscreenVideo.frame();
        }
        script.run(1000);
        continue;
      }
      if (runtime.runMode === 8) {
        // Network progress needs the host event loop and real frame callbacks. A waiting
        // script alone is not evidence that boot or the requested click recipe completed.
        const started = Date.now();
        let cancelledWithEscape = false;
        while (runtime.runMode === 8 && !runtime.resourcePending) {
          if (Date.now() - started > 30000) throw Error('Probe HTTP wait exceeded 30 seconds');
          await new Promise((resolve) => setTimeout(resolve, 10));
          const cancel =
            httpCancelAfter !== null &&
            !cancelledWithEscape &&
            Date.now() - started >= httpCancelAfter;
          runtime.frame((runtime.now + 16) >>> 0 || 1, {
            sample: {down: new Set(cancel ? [27] : []), pointerInside: true},
          });
          cancelledWithEscape ||= cancel;
        }
        httpWaits.push({
          wallMilliseconds: Date.now() - started,
          cancelledWithEscape,
          runMode: runtime.runMode,
        });
        continue;
      }
      if (
        startSaveFile !== undefined &&
        startSaveLoadReport === null &&
        runtime.runMode === 3 &&
        !wait.pending
      ) {
        const loaded = await loadFile(startSaveFile);
        const sha256 = createHash('sha256').update(loaded).digest('hex');
        startSaveLoadReport = {
          file: startSaveFile,
          sha256,
          expected: expectedStartSha256 ?? null,
          matched: expectedStartSha256 === undefined ? null : sha256 === expectedStartSha256,
          runMode: runtime.runMode,
          callDepth: script.callDepth,
          freshProcess: true,
        };
        if (reportDir !== undefined) writeFileSync(`${reportDir}/start-loaded-state.bin`, loaded);
        if (startSaveLoadReport.matched === false)
          throw Error('Probe fresh scenario state differs');
        script.run(1000);
        continue;
      }
      if (
        !probeInputs.length &&
        autoChoices > 0 &&
        autoChoicePrefixes.length &&
        runtime.runMode === 3 &&
        !wait.pending
      ) {
        const clickable = runtime.layers.clickableLayers();
        const id = autoChoicePrefixes
          .map((prefix) => clickable.find((candidate) => candidate.startsWith(prefix)))
          .find((candidate) => candidate !== undefined);
        if (id !== undefined) {
          autoChoices--;
          autoChoiceLog.push({id, click: deliveredClicks, tags: nativeTags.length});
          modeEffects.push({autoChoice: id, simulation: true});
          probeInputs.push({id, type: 'press'});
        }
      }
      const stopInput = timedInputs.findIndex((input) => input.stop && input.at <= deliveredClicks);
      if (!probeInputs.length && stopInput >= 0 && runtime.runMode === 3 && !wait.pending) {
        const [{id, type, key}] = timedInputs.splice(stopInput, 1);
        probeInputs.push(id === undefined ? {key} : {id, type});
      }
      if (probeInputs.length && runtime.runMode === 3 && !wait.pending) {
        const input = probeInputs.shift();
        if (input.type === 'press') {
          modeEffects.push({press: input.id, simulation: true});
          await pointerPress(input.id);
        } else if (input.id !== undefined) {
          modeEffects.push({layerEvent: input, simulation: true});
          runtime.layerEvent(input.id, input.type);
        } else {
          modeEffects.push({keyPush: input.key, simulation: true});
          runtime.keyPush(input.key);
        }
        script.run(1000);
        continue;
      }
      if (wait.clickPending && probeClicks > 0) {
        const timed = timedInputs.findIndex((input) => !input.stop && input.at === deliveredClicks);
        if (timed >= 0) {
          const [{id, type, key}] = timedInputs.splice(timed, 1);
          if (id === undefined) {
            modeEffects.push({keyPush: key, click: deliveredClicks, simulation: true});
            runtime.keyPush(key);
          } else if (type === 'press') {
            // As for a probe click, the text display completes first: game Lua treats a
            // key 1 press during the reveal as a plain click.
            for (let count = 0; !runtime.textDisplayComplete; count++) {
              if (count >= 100000) throw Error('Probe click-wait display did not finish');
              frame();
              wait.tick(runtime.now);
            }
            modeEffects.push({press: id, click: deliveredClicks, simulation: true});
            await pointerPress(id);
          } else {
            modeEffects.push({layerEvent: {id, type}, click: deliveredClicks, simulation: true});
            runtime.layerEvent(id, type);
          }
          script.run(1000);
          continue;
        }
        if (
          runtime.modes.automode &&
          automodeLimit !== null &&
          automodeWaits.length >= automodeLimit &&
          !automodeStop
        ) {
          for (let count = 0; !runtime.textDisplayComplete; count++) {
            if (count >= 100000) throw Error('Probe click-wait display did not finish');
            frame();
            wait.tick(runtime.now);
          }
          modeEffects.push({press: null, click: deliveredClicks, simulation: true});
          await pointerPress(null);
          automodeStop = {click: deliveredClicks, automode: runtime.modes.automode};
          script.run(1000);
          continue;
        }
        if (runtime.modes.automode) {
          // Automode: 16 ms run mode 1 frames without a click until the wait ends.
          const start = runtime.now;
          for (let count = 0; wait.clickPending && runtime.modes.automode; count++) {
            if (count >= 100000) throw Error('Probe automode click-wait did not finish');
            frame();
            if (wait.pending) wait.tick(runtime.now, false, true);
          }
          automodeWaits.push((runtime.now - start) >>> 0);
          script.run(1000);
          continue;
        }
        for (let count = 0; !runtime.textDisplayComplete; count++) {
          if (count >= 100000) throw Error('Probe click-wait display did not finish');
          frame();
          wait.tick(runtime.now);
          if (!wait.clickPending) break;
        }
        // A frame event (for example a sound finish handler) took the caret: its handler runs
        // first and the click-wait returns with the caret.
        if (!wait.clickPending) {
          script.run(1000);
          continue;
        }
        if (saveLoadAt !== null && deliveredClicks === saveLoadAt && !saveLoadReport) {
          // The loaded caret resumes at the tag after the click-wait instead of a click.
          await saveLoadRoundTrip();
          script.run(1000);
          continue;
        }
        deliveredClicks++;
        probeClicks--;
        if (luaMemoryEvery && deliveredClicks % luaMemoryEvery === 0) {
          const count = lua.vm.referenceGlobal('collectgarbage');
          try {
            luaMemory.push({
              click: deliveredClicks,
              kib: count.invokeFirst([new TextEncoder().encode('count')]),
              wasmBytes: lua.vm.exports.memory.buffer.byteLength,
              // The registry slot of this temporary reference: luaL_ref reuses freed slots,
              // so a growing number means host references that were never released.
              registryRef: count.id,
            });
          } finally {
            count.release();
          }
        }
        runtime.now = (runtime.now + 16) >>> 0 || 1;
        modeEffects.push({click: true, simulation: true});
        if (!wait.tick(runtime.now, true))
          throw Error(
            'Probe click did not end the click-wait: ' +
              JSON.stringify({
                runMode: runtime.runMode,
                pending: wait.pending,
                click: wait.clickPending,
                display: runtime.textDisplayComplete,
                skipping: runtime.skipping,
              }),
          );
        script.run(1000);
        continue;
      }
      if (advanceWaits && wait.scenarioPending && advancedWaits < 1000000) {
        // Deterministic 16 ms frames until the text display completes; no click is simulated.
        for (let count = 0; ; count++) {
          if (count >= 100000) throw Error('Probe scenario wait did not finish');
          frame();
          if (!wait.pending || wait.tick(runtime.now)) break;
        }
        advancedWaits++;
        script.run(1000);
        continue;
      }
      if (advanceWaits && (wait.videoPending || wait.soundPending) && advancedWaits < 1000000) {
        // Deterministic 16 ms frames play the video or se until it stops; no click.
        for (let count = 0; ; count++) {
          if (count >= 100000) throw Error('Probe video/se wait did not finish');
          frame();
          if (!wait.pending || wait.tick(runtime.now)) break;
        }
        advancedWaits++;
        script.run(1000);
        continue;
      }
      if (
        advanceWaits &&
        !wait.pending &&
        runtime.runMode !== 3 &&
        lua.events.handler('onEnterFrame')
      ) {
        // Lua may hold a caret until an asynchronous preload completes in onEnterFrame.
        // Advancing only sound/tween time cannot release that wait.
        const tagsBefore = nativeTags.length,
          modeBefore = runtime.runMode;
        let progressed = false;
        for (let count = 0; count < 500; count++) {
          await new Promise((resolve) => setTimeout(resolve, 10));
          runtime.frame((runtime.now + 16) >>> 0 || 1, {
            sample: {down: new Set(), pointerInside: true},
          });
          if (
            runtime.resourcePending ||
            wait.pending ||
            script.state !== 'waiting' ||
            runtime.runMode !== modeBefore ||
            nativeTags.length !== tagsBefore
          ) {
            progressed = true;
            break;
          }
        }
        if (!progressed) throw Error('Probe frame-owned wait did not progress in 5 seconds');
        continue;
      }
      if (!advanceWaits || !wait.pending || wait.clickPending || advancedWaits >= 1000000) break;
      // 16 ms frames up to the deadline keep sound and video layers advancing meanwhile.
      const deadline = (wait.deadlineTick + 1) >>> 0;
      while (((deadline - runtime.now) | 0) > 16) frame();
      advancedWaits++;
      runtime.advanceTo(((deadline - runtime.now) | 0) > 0 ? deadline : runtime.now);
      // A sound-finish handler may end the wait during the frames. In automode a playing
      // syncse sound holds the passed deadline; 16 ms frames continue until it stops.
      if (wait.pending && !wait.tick(runtime.now)) {
        if (!runtime.modes.automode) break;
        for (let count = 0; wait.pending && !wait.tick(runtime.now); count++) {
          if (count >= 100000) throw Error('Probe automode syncse wait did not finish');
          frame();
        }
      }
      script.run(1000);
    }
  } catch (error) {
    refusal = error.message;
    if (process.env.ARTEMIS_PROBE_STACK) console.error(error.stack, error.hostCause?.stack ?? '');
  }
  // ARTEMIS_PROBE_LUA: diagnostic Lua chunk run after the route; it sets global probe_out.
  // A chunk that sets global probe_done to false runs again (each run has its own instruction
  // budget), at most 10000 times, until it sets probe_done to true.
  let probeLua;
  if (process.env.ARTEMIS_PROBE_LUA) {
    try {
      const chunk = new TextEncoder().encode(process.env.ARTEMIS_PROBE_LUA);
      lua.vm.execute(chunk, 'probe');
      for (let runs = 1; lua.vm.getGlobal('probe_done') === false && runs < 10000; runs++)
        lua.vm.execute(chunk, 'probe');
      probeLua = luaText(lua.vm.getGlobal('probe_out') ?? '');
    } catch (error) {
      probeLua = 'error: ' + error.message;
    }
  }
  await runtime.flushSaves();
  try {
    await surfaceFixture.manager.waitForLoads();
  } catch (error) {
    refusal = refusal ? `${refusal}; preload: ${error.message}` : error.message;
  }
  // --ast-check=NAME: exercise the game's own AST loader (Lua `readScriptFile`) on NAME
  // after the route. flag=true is its load-only path, avoiding image-cache deletion.
  let astLoadedByGame = null,
    ast = null;
  if (astCheck !== undefined) {
    const loader = lua.vm.referenceGlobal('readScriptFile');
    try {
      astLoadedByGame = loader.invoke([new TextEncoder().encode(astCheck), true])[0];
    } finally {
      loader.release();
    }
    if (astLoadedByGame !== true) throw new Error('Game AST loader did not confirm the source');
    ast = lua.vm.getGlobal('ast');
  }
  if (saveDir !== undefined)
    for (const [name, bytes] of saveFiles) writeFileSync(`${saveDir}/${name}`, bytes);
  console.log(
    reportText({
      executableSha256,
      dialogRequests: dialogs,
      saveLoad: saveLoadReport,
      startSaveLoad: startSaveLoadReport,
      autoChoices: autoChoiceLog,
      clickableLayers: runtime.layers.clickableLayers(),
      automodeWaits,
      httpWaits,
      automodeStop,
      probeLua,
      saveFiles: Object.fromEntries(
        [...saveFiles].map(([name, bytes]) => [name, {bytes: bytes.length}]),
      ),
      dialogPending: runtime.dialog.pending,
      simulatedDialogResult,
      simulatedWindowsVersion,
      graphicsFeatureLevel:
        simulatedGraphicsFeatureLevel === null
          ? null
          : {value: simulatedGraphicsFeatureLevel, simulation: true},
      advanceWaits,
      advancedWaits,
      timedWaitPending: wait.pending,
      effectMode: 'record-only',
      metadataLayerFixture: layerFixture.snapshot(),
      fontStackFixture: {
        depth: runtime.fontStack.depth(),
        fontRendering: false,
        simulation: true,
      },
      messageSelectionFixture: {
        current: runtime.messageSelection.currentMessageLayer(),
        depth: runtime.messageSelection.depth,
        presentation: false,
        simulation: true,
      },
      pointerPositionFixture: {x: 0, y: 0, simulation: true},
      resourceResumptions,
      preparedFiles: runtime.prepared.size,
      preparedBytes: runtime.preparedBytes,
      compiled: runtime.compiled,
      nativeIncludeReporting,
      luaIncludeErrors,
      nativeCallLuaReporting,
      luaCallErrors,
      unknownTagReports,
      tagErrorReports,
      luaMemory,
      luaVersion: luaText(lua.vm.getGlobal('_VERSION')),
      state: script.state,
      refusal,
      events,
      nativeTags,
      includes,
      modeEffects,
      glyphLayoutFixture: glyphFixture.summary(),
      surfacePreloadFixture: surfaceFixture.summary(),
      soundDecodeFixture: soundFixture.summary(),
      shaderFixture: shaderFixture?.summary(),
      astLoadedByGame,
      astVersion: lua.vm.getGlobal('astver'),
      astTopLevelKeys: ast?.size ?? null,
    }),
  );
} finally {
  runtime?.close();
  await glyphFixture?.close();
  await surfaceFixture?.close();
  await soundFixture?.close();
  shaderFixture?.close();
  await installation.close();
}
