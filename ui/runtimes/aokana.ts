import {BlobSource} from '../../src/core/source.js';
import {BrowserAudioContextHost} from '../../src/audio/browser-audio-context-host.js';
import {beginRuntimeActivity} from '../../src/platform/runtime-activity.js';
import {
  MountedFileSystem,
  OverlayFileSystem,
  SourceFileSystem,
  StoredFileSystem,
  filePath,
} from '../../src/platform/filesystem.js';
import {BrowserX86CompatibilityCpuHost} from '../../src/platform/browser-x86-cpu.js';
import {
  BrowserWindowDisplayHost,
  browserDesktopSize,
} from '../../src/platform/browser-window-display.js';
import {IndexedDbStore, MemoryStore, type RecordStore} from '../../src/platform/store.js';
import {mountInstallationControls} from '../player/installation-controls.js';
import type {CachedInstallation} from '../../src/platform/installation-cache.js';
import type {InstallationSelection} from '../../src/platform/installation-picker.js';
import {mountGameViewer} from '../player/game-viewer.js';
import {setRuntimeState, subscribeSaveBusy} from '../player/runtime-state.js';
import {mountFullscreenControls} from '../player/fullscreen.js';
import {AokanaBpMemory} from '../../src/engines/buriko/games/aokana/bp/memory.js';
import {
  AokanaBrowserSpeakerBackend,
  AokanaMemorySpeakerBackend,
  type AokanaSpeakerBackend,
} from '../../src/engines/buriko/games/aokana/native/audio/speaker-backend.js';
import {AokanaBpDiagnostics} from '../../src/engines/buriko/games/aokana/native/diagnostics.js';
import {readAokanaCursorResource} from '../../src/engines/buriko/games/aokana/native/cursor-shapes.js';
import {
  AokanaMountedFileMetadata,
  type AokanaFileMetadataRecord,
} from '../../src/engines/buriko/games/aokana/native/file-metadata.js';
import {AokanaMountedProgramPaths} from '../../src/engines/buriko/games/aokana/native/program-paths.js';
import {AokanaProgramMedia} from '../../src/engines/buriko/games/aokana/native/program-files.js';
import {AokanaProductionBootRunner} from '../../src/engines/buriko/games/aokana/native/production-boot-runner.js';
import {AokanaProductionDataOwners} from '../../src/engines/buriko/games/aokana/native/production-data-owners.js';
import {AokanaProductionDisplayResourceGraph} from '../../src/engines/buriko/games/aokana/native/production-display-resource-graph.js';
import {AokanaProductionVmCore} from '../../src/engines/buriko/games/aokana/native/production-vm-core.js';
import {aokanaRegistryFold} from '../../src/engines/buriko/games/aokana/native/registry-case.js';
import {AokanaNativeText} from '../../src/engines/buriko/games/aokana/native/text.js';

interface Installation {
  files: SourceFileSystem;
  modifiedFiles: {path: string; lastModifiedMs: number}[];
  cursor: Uint8Array;
  executableName: string;
}

const chooseButton = document.querySelector<HTMLButtonElement>('#choose')!;
const choose = document.querySelector<HTMLInputElement>('#files')!;
const play = document.querySelector<HTMLButtonElement>('#play')!;
const welcome = document.querySelector<HTMLElement>('#welcome')!;
const fatalError = document.querySelector<HTMLElement>('#fatal-error')!;
const skipStartup = document.querySelector<HTMLButtonElement>('#skip-startup')!;
const playbackOptions = document.querySelector<HTMLElement>('#playback-options')!;
const status = document.querySelector<HTMLElement>('#status')!;
const prompt = document.querySelector<HTMLElement>('#prompt')!;
const viewport = document.querySelector<HTMLElement>('#display-viewport')!;
const surface = document.querySelector<HTMLElement>('#surface')!;
const windowLayer = document.querySelector<HTMLElement>('#window-layer')!;
const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas')!;
const diagnosticMode = document.documentElement.classList.contains('no-canvas');
const {collapseOptions} = mountGameViewer('aokana');
let fullscreenControls: ReturnType<typeof mountFullscreenControls> | undefined;
const displayHost = new BrowserWindowDisplayHost(
  document.querySelector<HTMLElement>('#display')!,
  viewport,
  surface,
  () => fullscreenControls?.refresh(),
  report,
  windowLayer,
);
fullscreenControls = mountFullscreenControls(displayHost);
let selected: Installation | null = null;
let selectedSnapshot: CachedInstallation | null = null;
let running = false;
let loading = false;
let saveBusy = false;
function syncControls(): void {
  setRuntimeState({running, busy: loading});
  play.disabled = running || loading || saveBusy || selected === null;
}

function report(message: string): void {
  status.textContent = message;
  prompt.textContent = message;
}

function clearFatalError(): void {
  fatalError.hidden = true;
  fatalError.textContent = '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function source(): SourceFileSystem {
  return new SourceFileSystem((path) => aokanaRegistryFold(filePath(path)));
}

function mountedKey(path: string): string {
  path = filePath(path);
  if (path === '/') return path;
  const end = path.indexOf('/', 1);
  return end < 0 ? path : path.slice(0, end) + aokanaRegistryFold(path.slice(end));
}

async function requireBootArchive(files: SourceFileSystem): Promise<void> {
  const boot = await files.stat('/system.arc').catch(() => null);
  if (boot?.kind !== 'file') throw new Error('The selected installation has no system.arc.');
}

async function chosenFiles(selection: InstallationSelection): Promise<Installation> {
  const files = source();
  const modifiedFiles: Installation['modifiedFiles'] = [];
  const executables: File[] = [];
  for (const {path: selectedPath, file} of selection.files) {
    const relative = selectedPath.slice(1);
    if (!relative) continue;
    const path = filePath('/' + relative);
    files.attach(path, new BlobSource(file));
    modifiedFiles.push({path, lastModifiedMs: file.lastModified});
    if (!relative.includes('/') && relative.toLowerCase().endsWith('.exe')) executables.push(file);
  }
  await requireBootArchive(files);
  if (executables.length === 0)
    throw new Error(
      `The browser returned ${selection.files.length} files but no executable in the game folder. Check the selected file list, try the browser folder picker, or use Add one file to add the game's .exe.`,
    );
  if (executables.length > 1)
    throw new Error(
      `The browser returned ${executables.length} executables: ${executables.map((file) => file.name).join(', ')}. Select the game files with only the game's executable.`,
    );
  const cursor = readAokanaCursorResource(new Uint8Array(await executables[0]!.arrayBuffer()));
  if (cursor === null) throw new Error('The selected executable has no static cursor group 106.');
  return {files, modifiedFiles, cursor, executableName: executables[0]!.name};
}

function fileTime(): bigint {
  return (BigInt(Date.now()) + 11644473600000n) * 10000n;
}

async function launch(
  installation: Installation,
  backend: AokanaSpeakerBackend,
  presentationMode: 'canvas' | 'none',
): Promise<void> {
  const finishStartup = beginRuntimeActivity('Starting game');
  const stores: RecordStore[] = [];
  const openStore = async (name: string): Promise<IndexedDbStore> => {
    const store = await IndexedDbStore.open(['aokana', 'default', name]);
    stores.push(store);
    return store;
  };
  let graph: AokanaProductionDisplayResourceGraph | null = null;
  let core: AokanaProductionVmCore | null = null;
  let booted = false;
  let skipping = false;
  const requestSkip = (): void => {
    if (graph === null) return;
    skipping = !skipping;
    graph.input.skipForced = Number(skipping);
    graph.mfMovieSession.setAutoSkip(skipping);
    graph.traditionalMovieSession.setAutoSkip(skipping);
    skipStartup.textContent = skipping ? 'Stop skipping' : 'Skip startup sequence';
    skipStartup.setAttribute('aria-pressed', String(skipping));
    report(skipping ? 'Skipping startup sequence…' : 'Startup skip stopped.');
  };
  try {
    const gameStore = await openStore('game');
    const userStore = await openStore('user');
    const registryStore = await openStore('registry');
    const temporaryStore = new MemoryStore();
    stores.push(temporaryStore);
    const backing = new MountedFileSystem();
    backing.mount(
      '/game',
      new OverlayFileSystem(installation.files, gameStore, aokanaRegistryFold),
    );
    backing.mount('/user', new StoredFileSystem(userStore, aokanaRegistryFold));
    backing.mount('/temp', new StoredFileSystem(temporaryStore, aokanaRegistryFold));
    const mounted = new AokanaMountedFileMetadata(backing, {
      records: [
        ...installation.modifiedFiles.map(({path, lastModifiedMs}): AokanaFileMetadataRecord => ({
          path: '/game' + path,
          kind: 'file',
          attributes: null,
          creationTime: null,
          accessTime: null,
          writeTime: (BigInt(Math.trunc(lastModifiedMs)) + 11644473600000n) * 10000n,
        })),
        ...['Desktop', 'Programs', 'Documents'].map((name): AokanaFileMetadataRecord => ({
          path: `/user/${name}`,
          kind: 'directory',
          attributes: 0x10,
          creationTime: null,
          accessTime: null,
          writeTime: null,
        })),
      ],
      volumes: [
        {path: '/game', identity: gameStore, writable: true},
        {path: '/user', identity: userStore, writable: true},
        {path: '/temp', identity: temporaryStore, writable: true},
      ],
      canonical: mountedKey,
      currentFileTime: fileTime,
      accessTimePolicy: 'disabled',
    });
    const paths = new AokanaMountedProgramPaths(
      [
        {native: 'C:\\game', mounted: '/game'},
        {native: 'C:\\UserData', mounted: '/user'},
        {native: 'T:\\', mounted: '/temp'},
        {native: 'D:\\Drops', mounted: '/drops'},
      ],
      'C:\\game',
    );
    const text = new AokanaNativeText();
    const encode = (value: string): Uint8Array => text.encodeWide(value, 1);
    const media = new AokanaProgramMedia();
    media.setDriveType(2, 3);
    const cpu = new BrowserX86CompatibilityCpuHost(performance);
    const [width, height] = browserDesktopSize(window);
    graph = new AokanaProductionDisplayResourceGraph({
      document,
      parent: surface,
      canvas,
      displayHost,
      childWindowCoordinates: displayHost.coordinates,
      childWindowParent: displayHost.auxiliaryLayer,
      presentationMode,
      navigator,
      readViewportScreenMapping: () => displayHost.readViewportScreenMapping(),
      monitors: [[0, 0, width, height]],
      selectedMonitor: 0,
      primaryMonitor: 0,
      clientOrigin: [0, 0],
      adapters: [
        {
          monitor: 0,
          pixelShaderVersion: 0,
          mode: {
            width,
            height,
            refreshRate: 60,
            format: 22,
          },
        },
      ],
      damageCapacity: 16,
      childMetrics: {
        frameWidth: 0,
        frameHeight: 0,
        verticalScrollbarWidth: 0,
        horizontalScrollbarHeight: 0,
      },
      nativeWindowTitle: encode('Aokana'),
      preferredDialogTitle: null,
      cursorResource: installation.cursor,
      performance,
      readSystemTime: () => new Date(),
      readLocalTime: () => new Date(),
      cpuHost: cpu,
      registryStore,
      specialFolderProfile: {
        shellAllocatorAvailable: true,
        windows: 'C:\\Windows',
        programFiles: 'C:\\Program Files',
        currentUser: {
          desktop: 'C:\\UserData\\Desktop',
          programs: 'C:\\UserData\\Programs',
          documents: 'C:\\UserData\\Documents',
          profile: 'C:\\UserData',
        },
        shellUser: {
          desktop: 'C:\\UserData\\Desktop',
          programs: 'C:\\UserData\\Programs',
          documents: 'C:\\UserData\\Documents',
          profile: 'C:\\UserData',
        },
        elevated: false,
        shellTokenAvailable: false,
        debugPrivilegeAvailable: false,
        shellAccountName: null,
      },
      readUserDefaultUiLanguage: () => 0x409,
      localizedText: null,
      processorCount: BrowserX86CompatibilityCpuHost.logicalProcessors,
      executablePathWide: `C:\\game\\${installation.executableName}`,
      commandLineTailWide: '',
      drop: {mountedRoot: '/drops', nativeRoot: 'D:\\Drops'},
      resource: {
        mounted,
        paths,
        media,
        configuration: {
          nativeFileRoot: 'C:\\game\\',
          primaryRoot: encode('C:\\game\\'),
          secondaryRoot: Uint8Array.of(0),
          secondaryMediaPath: '',
          searchDirectoriesEnabled: 0,
          searchDirectories: [],
          retryTitle: Uint8Array.of(0),
          retryMessage: Uint8Array.of(0),
          quitConfirmation: Uint8Array.of(0),
        },
        errorDirectory: encode('C:\\game\\'),
        workingDirectory: encode('C:\\game\\'),
        audioRootWide: 'C:\\game\\',
        backend,
        output: {prefer24Bit: false},
        resourceWorkerCount: 1,
        sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      },
    });
    skipStartup.hidden = false;
    skipStartup.disabled = false;
    playbackOptions.hidden = false;
    skipStartup.textContent = 'Skip startup sequence';
    skipStartup.setAttribute('aria-pressed', 'false');
    skipStartup.addEventListener('click', requestSkip);
    // C3CB0 creates logical preset 2 (800 × 600) before B11F0 initializes D3D.
    // IPL later restores BGI.gdb and selects its saved client size through 81:64.
    graph.display.requestedWidth = 800;
    graph.display.requestedHeight = 600;
    const memory = new AokanaBpMemory(new Uint8Array(0x10000));
    const data = new AokanaProductionDataOwners(graph, memory);
    const diagnostics = new AokanaBpDiagnostics((notice) => {
      console.info('Aokana write watch', notice);
    });
    core = new AokanaProductionVmCore(graph, data, diagnostics);
    const runner = await AokanaProductionBootRunner.start(core);
    finishStartup();
    booted = true;
    report('Aokana is running.');
    await runner.run();
    report('Aokana closed.');
  } finally {
    finishStartup();
    skipStartup.removeEventListener('click', requestSkip);
    skipStartup.disabled = true;
    skipStartup.hidden = true;
    playbackOptions.hidden = true;
    if (graph !== null) {
      graph.input.skipForced = 0;
      graph.mfMovieSession.setAutoSkip(false);
      graph.traditionalMovieSession.setAutoSkip(false);
    }
    if (!booted) {
      try {
        await core?.close();
      } catch {
        /* Retain launch failure. */
      }
      try {
        await graph?.shutdown();
      } catch {
        /* Retain launch failure. */
      }
    }
    for (const store of stores) store.close();
    displayHost.setFullscreen(false);
  }
}

function installationSnapshot(installation: Installation): CachedInstallation {
  const modified = new Map(
    installation.modifiedFiles.map(({path, lastModifiedMs}) => [
      aokanaRegistryFold(path),
      lastModifiedMs,
    ]),
  );
  return {
    files: Array.from(installation.files.entries(), ([path, source]) => ({
      path,
      source,
      lastModifiedMs: modified.get(path) ?? 0,
    })),
    metadata: {executableName: installation.executableName},
    attachments: {cursor: new Blob([installation.cursor.slice().buffer])},
  };
}

const installationControls = mountInstallationControls({
  key: 'aokana',
  choose: chooseButton,
  input: choose,
  current: () => selectedSnapshot,
  canonicalPath: aokanaRegistryFold,
  busy: () => running || loading || saveBusy,
  setBusy: (busy) => {
    loading = busy;

    syncControls();
    if (busy) clearFatalError();
  },
  report,
  select: async (selection) => {
    selected = null;
    selectedSnapshot = null;
    selected = await chosenFiles(selection);
    selectedSnapshot = installationSnapshot(selected);
  },
  load: async (snapshot) => {
    const files = source();
    for (const entry of snapshot.files) files.attach(entry.path, entry.source);
    await requireBootArchive(files);
    const executableName = snapshot.metadata.executableName;
    if (
      !executableName ||
      executableName.includes('/') ||
      filePath('/' + executableName).slice(1) !== executableName
    )
      throw new Error('The saved installation has no valid executable name.');
    const cursor = snapshot.attachments.cursor;
    if (!cursor || !cursor.size || cursor.size > 16 * 1024 * 1024)
      throw new Error('The saved installation has no valid cursor resource.');
    selected = {
      files,
      modifiedFiles: snapshot.files.map(({path, lastModifiedMs}) => ({path, lastModifiedMs})),
      executableName,
      cursor: new Uint8Array(await cursor.arrayBuffer()),
    };
    selectedSnapshot = snapshot;
  },
  clear: () => {
    selected = null;
    selectedSnapshot = null;
  },
});

play.addEventListener('click', async () => {
  if (selected === null || running || loading || saveBusy) return;
  const mode = diagnosticMode ? 'none' : 'canvas';
  clearFatalError();
  if (surface.parentElement !== viewport) viewport.insertBefore(surface, windowLayer);
  surface.style.visibility = '';
  windowLayer.style.visibility = '';
  running = true;
  syncControls();
  welcome.hidden = true;
  play.disabled = true;

  chooseButton.disabled = true;
  choose.disabled = true;
  installationControls.refresh();
  collapseOptions(true);
  report('Starting Aokana…');
  let audio: AudioContext | null = null;
  let audioHost: BrowserAudioContextHost | null = null;
  try {
    const backend =
      mode === 'none'
        ? new AokanaMemorySpeakerBackend(48000)
        : new AokanaBrowserSpeakerBackend((audio = new AudioContext()));
    if (audio !== null) {
      audioHost = new BrowserAudioContextHost(audio, document);
      await audioHost.resume();
    }
    await launch(selected, backend, mode);
  } catch (error) {
    report('Aokana stopped.');
    fatalError.textContent = errorMessage(error);
    fatalError.hidden = false;
    console.error(error);
  } finally {
    audioHost?.dispose();
    try {
      if (audio !== null && audio.state !== 'closed') await audio.close();
    } catch (error) {
      console.error('Audio cleanup failed', error);
    } finally {
      running = false;
      syncControls();
      welcome.hidden = false;

      chooseButton.disabled = false;
      choose.disabled = false;
      installationControls.refresh();
      syncControls();
    }
  }
});

subscribeSaveBusy((value) => {
  saveBusy = value;
  syncControls();
  installationControls.refresh();
});
