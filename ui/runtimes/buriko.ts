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
import {BrowserWindowsProcessInstanceHost} from '../../src/platform/windows-process-instance.js';
import {
  BrowserWindowDisplayHost,
  browserDesktopSize,
} from '../../src/platform/browser-window-display.js';
import {IndexedDbStore, MemoryStore, type RecordStore} from '../../src/platform/store.js';
import {mountInstallationControls} from '../player/installation-controls.js';
import type {CachedInstallation, InstallationFile} from '../../src/platform/installation-cache.js';
import type {InstallationSelection} from '../../src/platform/installation-picker.js';
import {mountGameViewer} from '../player/game-viewer.js';
import {setRuntimeState, subscribeSaveBusy} from '../player/runtime-state.js';
import {mountFullscreenControls} from '../player/fullscreen.js';
import {BurikoBpMemory} from '../../src/engines/buriko/bp/memory.js';
import {
  BurikoBrowserSpeakerBackend,
  BurikoMemorySpeakerBackend,
  type BurikoSpeakerBackend,
} from '../../src/engines/buriko/native/audio/speaker-backend.js';
import {BurikoBpDiagnostics} from '../../src/engines/buriko/native/diagnostics.js';
import {burikoEngineVersion} from '../../src/engines/buriko/native/engine-version.js';
import {inspectBurikoInstallation, type BurikoExecutable} from './buriko-installation.js';
import {activeBurikoGame, burikoTitle, rememberBurikoGame} from '../player/buriko-library.js';
import {legacyAokanaRoute} from '../game-profiles/aokana.js';
import {
  BurikoMountedFileMetadata,
  type BurikoFileMetadataRecord,
} from '../../src/engines/buriko/native/file-metadata.js';
import {BurikoMountedProgramPaths} from '../../src/engines/buriko/native/program-paths.js';
import {BurikoProgramMedia} from '../../src/engines/buriko/native/program-files.js';
import {BurikoProductionBootRunner} from '../../src/engines/buriko/native/production-boot-runner.js';
import {BurikoProductionDataOwners} from '../../src/engines/buriko/native/production-data-owners.js';
import {BurikoProductionDisplayResourceGraph} from '../../src/engines/buriko/native/production-display-resource-graph.js';
import {BurikoProductionVmCore} from '../../src/engines/buriko/native/production-vm-core.js';
import {burikoRegistryFold} from '../../src/engines/buriko/native/registry-case.js';
import {BurikoNativeText} from '../../src/engines/buriko/native/text.js';

interface Installation extends BurikoExecutable {
  /** Keep the raw selection for handle/cache restoration, before runtime projection. */
  selectedFiles: readonly InstallationFile[];
  selectedDirectories: readonly string[];
  files: SourceFileSystem;
  modifiedFiles: {path: string; lastModifiedMs: number}[];
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
const textMode = document.querySelector<HTMLSelectElement>('#text-mode')!;
let activeGraph: BurikoProductionDisplayResourceGraph | null = null;
textMode.onchange = () => {
  try {
    activeGraph?.setTextMode(textMode.value === 'dom' ? 'dom' : 'native');
  } catch (error) {
    textMode.value = 'native';
    activeGraph?.setTextMode('native');
    report(errorMessage(error));
  }
};
const {collapseOptions} = mountGameViewer('buriko');
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
  return new SourceFileSystem((path) => burikoRegistryFold(filePath(path)));
}

function mountedKey(path: string): string {
  path = filePath(path);
  if (path === '/') return path;
  const end = path.indexOf('/', 1);
  return end < 0 ? path : path.slice(0, end) + burikoRegistryFold(path.slice(end));
}

async function chosenFiles(selection: InstallationSelection): Promise<Installation> {
  const entries = selection.files.map(({path, file}) => ({
    path,
    source: new BlobSource(file),
    lastModifiedMs: file.lastModified,
  }));
  const folderTitle =
    selection.directoryHandle?.name ||
    selection.files
      .find(({file}) => file.webkitRelativePath)
      ?.file.webkitRelativePath.split('/')[0];
  const executable = await inspectBurikoInstallation(entries, folderTitle);
  const files = source();
  for (const entry of executable.runtimeFiles) files.attach(entry.path, entry.source);
  for (const path of selection.directories ?? []) files.attachDirectory(path);
  return {
    selectedFiles: entries,
    selectedDirectories: selection.directories ?? [],
    files,
    modifiedFiles: executable.runtimeFiles.map(({path, lastModifiedMs}) => ({
      path,
      lastModifiedMs,
    })),
    ...executable,
  };
}

async function selectedInstallation(installation: Installation): Promise<void> {
  await rememberBurikoGame(installation.savedGame);
  selected = installation;
  activeBurikoGame.set(installation.savedGame);
  burikoTitle.set(installation.title);
  if (installation.metadataNotes.length !== 0)
    console.info('BGI installation metadata:', installation.metadataNotes);
}

function fileTime(): bigint {
  return (BigInt(Date.now()) + 11644473600000n) * 10000n;
}

async function launch(
  installation: Installation,
  backend: BurikoSpeakerBackend,
  presentationMode: 'canvas' | 'none',
): Promise<void> {
  if (installation.startupError !== null) throw new Error(installation.startupError);
  const finishStartup = beginRuntimeActivity('Starting game');
  const stores: RecordStore[] = [];
  const openStore = async (name: string): Promise<IndexedDbStore> => {
    const store = await IndexedDbStore.open([...installation.savedGame.namespace, name]);
    stores.push(store);
    return store;
  };
  let graph: BurikoProductionDisplayResourceGraph | null = null;
  let core: BurikoProductionVmCore | null = null;
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
    const gameFiles = new OverlayFileSystem(installation.files, gameStore, burikoRegistryFold);
    await gameFiles.installDirectories(installation.installationDirectories);
    backing.mount('/game', gameFiles);
    backing.mount('/user', new StoredFileSystem(userStore, burikoRegistryFold));
    backing.mount('/temp', new StoredFileSystem(temporaryStore, burikoRegistryFold));
    // Native directory probes validate C:\ before the separately mounted children.
    const driveRoot = source();
    driveRoot.attachDirectory('/game');
    driveRoot.attachDirectory('/UserData');
    backing.mount('/drive-c', driveRoot);
    const mounted = new BurikoMountedFileMetadata(backing, {
      records: [
        ...installation.modifiedFiles.map(({path, lastModifiedMs}): BurikoFileMetadataRecord => ({
          path: '/game' + path,
          kind: 'file',
          attributes: null,
          creationTime: null,
          accessTime: null,
          writeTime: (BigInt(Math.trunc(lastModifiedMs)) + 11644473600000n) * 10000n,
        })),
        ...['Desktop', 'Programs', 'Documents'].map((name): BurikoFileMetadataRecord => ({
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
    const paths = new BurikoMountedProgramPaths(
      [
        {native: 'C:\\game', mounted: '/game'},
        {native: 'C:\\UserData', mounted: '/user'},
        {native: 'C:\\', mounted: '/drive-c'},
        {native: 'T:\\', mounted: '/temp'},
        {native: 'D:\\Drops', mounted: '/drops'},
      ],
      'C:\\game',
    );
    const text = new BurikoNativeText();
    const encode = (value: string): Uint8Array => text.encodeWide(value, 1);
    const media = new BurikoProgramMedia();
    media.setDriveType(2, 3);
    const cpu = new BrowserX86CompatibilityCpuHost(performance);
    const [width, height] = browserDesktopSize(window);
    graph = new BurikoProductionDisplayResourceGraph({
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
      nativeWindowTitle: encode(installation.title),
      productIdentity: installation.productIdentity ?? Uint8Array.of(0),
      engineVersion: burikoEngineVersion(
        installation.interpreterVersion,
        installation.compatibilityVersion,
      ),
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
    activeGraph = graph;
    graph.setTextMode(textMode.value === 'dom' ? 'dom' : 'native');
    graph.display.requestedWidth = 800;
    graph.display.requestedHeight = 600;
    const memory = new BurikoBpMemory(new Uint8Array(0x10000), graph.engineVersion.bpAbi);
    const data = new BurikoProductionDataOwners(graph, memory);
    const diagnostics = new BurikoBpDiagnostics((notice) => {
      console.info('Buriko write watch', notice);
    }, graph.engineVersion.bpAbi);
    core = new BurikoProductionVmCore(graph, data, diagnostics);
    const runner = await BurikoProductionBootRunner.start(
      core,
      undefined,
      new BrowserWindowsProcessInstanceHost(
        installation.productIdentity === null ? installation.savedGame.id : undefined,
      ),
    );
    finishStartup();
    booted = true;
    report(`${installation.title} is running.`);
    await runner.run();
    report(`${installation.title} closed.`);
  } finally {
    finishStartup();
    activeGraph = null;
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
  return {
    files: [...installation.selectedFiles],
    directories: [...installation.selectedDirectories],
    metadata: {executableName: installation.executableName, title: installation.title},
    attachments: {},
  };
}

const installationControls = mountInstallationControls({
  key: legacyAokanaRoute(location.pathname) ? 'aokana' : 'buriko',
  choose: chooseButton,
  input: choose,
  current: () => selectedSnapshot,
  canonicalPath: burikoRegistryFold,
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
    activeBurikoGame.set(null);
    await selectedInstallation(await chosenFiles(selection));
    selectedSnapshot = installationSnapshot(selected!);
  },
  load: async (snapshot) => {
    selected = null;
    selectedSnapshot = null;
    activeBurikoGame.set(null);
    const executable = await inspectBurikoInstallation(snapshot.files, snapshot.metadata.title);
    const files = source();
    for (const entry of executable.runtimeFiles) files.attach(entry.path, entry.source);
    for (const path of snapshot.directories ?? []) files.attachDirectory(path);
    await selectedInstallation({
      selectedFiles: snapshot.files,
      selectedDirectories: snapshot.directories ?? [],
      files,
      modifiedFiles: executable.runtimeFiles.map(({path, lastModifiedMs}) => ({
        path,
        lastModifiedMs,
      })),
      ...executable,
      title: snapshot.metadata.title || executable.title,
    });
    selectedSnapshot = snapshot;
  },
  clear: () => {
    activeBurikoGame.set(null);
    burikoTitle.set('BGI / Ethornell');
    selected = null;
    selectedSnapshot = null;
  },
});

play.addEventListener('click', async () => {
  if (selected === null || running || loading || saveBusy) return;
  if (selected.startupError !== null) {
    report('This interpreter needs additional compatibility support.');
    fatalError.textContent = selected.startupError;
    fatalError.hidden = false;
    return;
  }
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
  report(`Starting ${selected.title}…`);
  let audio: AudioContext | null = null;
  let audioHost: BrowserAudioContextHost | null = null;
  try {
    const backend =
      mode === 'none'
        ? new BurikoMemorySpeakerBackend(48000)
        : new BurikoBrowserSpeakerBackend((audio = new AudioContext()));
    if (audio !== null) {
      audioHost = new BrowserAudioContextHost(audio, document);
      await audioHost.resume();
    }
    await launch(selected, backend, mode);
  } catch (error) {
    report('The game stopped.');
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
