import {BlobSource, HttpSource} from '../../../../core/source.js';
import {
  MountedFileSystem,
  OverlayFileSystem,
  SourceFileSystem,
  StoredFileSystem,
  filePath,
} from '../../../../platform/filesystem.js';
import {BrowserX86CompatibilityCpuHost} from '../../../../platform/browser-x86-cpu.js';
import {IndexedDbStore, MemoryStore, type RecordStore} from '../../../../platform/store.js';
import {AokanaBpMemory} from './bp/memory.js';
import {
  AokanaBrowserSpeakerBackend,
  AokanaMemorySpeakerBackend,
  type AokanaSpeakerBackend,
} from './native/audio/speaker-backend.js';
import {AokanaBpDiagnostics} from './native/diagnostics.js';
import {readAokanaCursorResource} from './native/cursor-shapes.js';
import {AokanaMountedFileMetadata} from './native/file-metadata.js';
import {AokanaMountedProgramPaths} from './native/program-paths.js';
import {AokanaProgramMedia} from './native/program-files.js';
import {AokanaProductionBootRunner} from './native/production-boot-runner.js';
import {AokanaProductionDataOwners} from './native/production-data-owners.js';
import {AokanaProductionDisplayResourceGraph} from './native/production-display-resource-graph.js';
import {AokanaProductionVmCore} from './native/production-vm-core.js';
import {aokanaRegistryFold} from './native/registry-case.js';
import {AokanaNativeText} from './native/text.js';

interface ServedFile {
  name: string;
  size: number;
  url: string;
}

interface Installation {
  files: SourceFileSystem;
  cursor: Uint8Array;
  executableName: string;
}

const connect = document.querySelector<HTMLButtonElement>('#connect')!;
const choose = document.querySelector<HTMLInputElement>('#files')!;
const play = document.querySelector<HTMLButtonElement>('#play')!;
const noCanvas = document.querySelector<HTMLInputElement>('#no-canvas')!;
const status = document.querySelector<HTMLElement>('#status')!;
const diagnosticLog = document.querySelector<HTMLElement>('#diagnostics')!;
const surface = document.querySelector<HTMLElement>('#surface')!;
const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas')!;
let selected: Installation | null = null;
let running = false;

function report(message: string): void {
  status.textContent = message;
  diagnosticLog.textContent = `${diagnosticLog.textContent ?? ''}${new Date().toLocaleTimeString()} ${message}\n`;
  diagnosticLog.scrollTop = diagnosticLog.scrollHeight;
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

async function servedFiles(): Promise<Installation> {
  const response = await fetch('/api/aokana/files');
  if (!response.ok) throw new Error(`Local game server returned HTTP ${response.status}.`);
  const manifest: unknown = await response.json();
  if (!Array.isArray(manifest)) throw new Error('The local game file manifest is invalid.');
  const files = source();
  for (const value of manifest) {
    const entry = value as Partial<ServedFile>;
    if (
      typeof entry.name !== 'string' ||
      !Number.isSafeInteger(entry.size) ||
      (entry.size ?? -1) < 0 ||
      typeof entry.url !== 'string'
    )
      throw new Error('The local game file manifest has an invalid entry.');
    const path = filePath('/' + entry.name);
    const url = new URL(entry.url, location.href);
    if (url.origin !== location.origin || !url.pathname.startsWith('/aokana-data/'))
      throw new Error('The local game file manifest points outside the game server.');
    files.attach(path, new HttpSource(url.href, entry.size!));
  }
  await requireBootArchive(files);
  const cursorResponse = await fetch('/api/aokana/cursor');
  if (!cursorResponse.ok) {
    const detail: unknown = await cursorResponse.json().catch(() => null);
    const message =
      detail !== null &&
      typeof detail === 'object' &&
      'message' in detail &&
      typeof detail.message === 'string'
        ? detail.message
        : `HTTP ${cursorResponse.status}`;
    throw new Error(`Cannot load the game's cursor resource: ${message}.`);
  }
  const encodedName = cursorResponse.headers.get('X-Aokana-Executable-Name');
  if (encodedName === null) throw new Error('The game server did not identify the executable.');
  const executableName = decodeURIComponent(encodedName);
  if (filePath('/' + executableName).slice(1) !== executableName || executableName.includes('/'))
    throw new Error('The game server returned an invalid executable name.');
  const cursor = new Uint8Array(await cursorResponse.arrayBuffer());
  if (cursor.length === 0 || cursor.length > 16 * 1024 * 1024)
    throw new Error('The game cursor resource has an invalid length.');
  return {files, cursor, executableName};
}

async function chosenFiles(selection: FileList): Promise<Installation> {
  const files = source();
  const executables: File[] = [];
  for (const file of Array.from(selection)) {
    const segments = file.webkitRelativePath.split('/');
    const relative = segments.length > 1 ? segments.slice(1).join('/') : file.name;
    if (!relative || relative === '.DS_Store' || relative.endsWith('/.DS_Store')) continue;
    files.attach(filePath('/' + relative), new BlobSource(file));
    if (!relative.includes('/') && relative.toLowerCase().endsWith('.exe')) executables.push(file);
  }
  await requireBootArchive(files);
  if (executables.length !== 1)
    throw new Error('Select a game folder containing exactly one Aokana executable.');
  const cursor = readAokanaCursorResource(new Uint8Array(await executables[0]!.arrayBuffer()));
  if (cursor === null) throw new Error('The selected executable has no static cursor group 106.');
  return {files, cursor, executableName: executables[0]!.name};
}

function fileTime(): bigint {
  return (BigInt(Date.now()) + 11644473600000n) * 10000n;
}

async function launch(
  installation: Installation,
  backend: AokanaSpeakerBackend,
  presentationMode: 'canvas' | 'none',
): Promise<void> {
  const stores: RecordStore[] = [];
  const openStore = async (name: string): Promise<IndexedDbStore> => {
    const store = await IndexedDbStore.open(['aokana', 'default', name]);
    stores.push(store);
    return store;
  };
  let graph: AokanaProductionDisplayResourceGraph | null = null;
  let core: AokanaProductionVmCore | null = null;
  let booted = false;
  try {
    report('Opening persistent storage…');
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
      records: ['Desktop', 'Programs', 'Documents'].map((name) => ({
        path: `/user/${name}`,
        kind: 'directory' as const,
        attributes: 0x10,
        creationTime: null,
        accessTime: null,
        writeTime: null,
      })),
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
    const width = Math.max(800, Math.floor(window.screen.width || 800));
    const height = Math.max(600, Math.floor(window.screen.height || 600));
    report('Constructing engine services…');
    graph = new AokanaProductionDisplayResourceGraph({
      document,
      parent: surface,
      canvas,
      presentationMode,
      navigator,
      readViewportScreenMapping: () => ({
        originX: window.screenX,
        originY: window.screenY,
        nativePixelsPerCssX: 1,
        nativePixelsPerCssY: 1,
      }),
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
    graph.display.requestedWidth = 800;
    graph.display.requestedHeight = 600;
    const memory = new AokanaBpMemory(new Uint8Array(0x10000));
    const data = new AokanaProductionDataOwners(graph, memory);
    const diagnostics = new AokanaBpDiagnostics((notice) => {
      console.info('Aokana write watch', notice);
    });
    core = new AokanaProductionVmCore(graph, data, diagnostics);
    report('Initializing display and native callbacks…');
    const runner = await AokanaProductionBootRunner.start(core);
    booted = true;
    report('Aokana is running.');
    await runner.run();
    report('Aokana closed.');
  } finally {
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
  }
}

noCanvas.checked = document.documentElement.classList.contains('no-canvas');
noCanvas.addEventListener('change', () => {
  if (running) return;
  document.documentElement.classList.toggle('no-canvas', noCanvas.checked);
  const url = new URL(location.href);
  if (noCanvas.checked) url.searchParams.set('no-canvas', '1');
  else url.searchParams.delete('no-canvas');
  history.replaceState(null, '', url);
});

connect.addEventListener('click', async () => {
  connect.disabled = true;
  selected = null;
  play.disabled = true;
  report('Reading local game file list…');
  try {
    selected = await servedFiles();
    play.disabled = false;
    report('Local Aokana installation ready. Press Play.');
  } catch (error) {
    report(errorMessage(error));
  } finally {
    connect.disabled = false;
  }
});

choose.addEventListener('change', async () => {
  if (!choose.files?.length) return;
  selected = null;
  play.disabled = true;
  try {
    selected = await chosenFiles(choose.files);
    play.disabled = false;
    report('Selected Aokana folder ready. Press Play.');
  } catch (error) {
    report(errorMessage(error));
  }
});

play.addEventListener('click', async () => {
  if (selected === null || running) return;
  const mode = noCanvas.checked ? 'none' : 'canvas';
  document.documentElement.classList.toggle('no-canvas', mode === 'none');
  running = true;
  play.disabled = true;
  connect.disabled = true;
  choose.disabled = true;
  noCanvas.disabled = true;
  report('Starting Aokana…');
  let audio: AudioContext | null = null;
  try {
    const backend =
      mode === 'none'
        ? new AokanaMemorySpeakerBackend(48000)
        : new AokanaBrowserSpeakerBackend((audio = new AudioContext()));
    if (audio !== null) await audio.resume();
    await launch(selected, backend, mode);
  } catch (error) {
    report(`Aokana stopped: ${errorMessage(error)}`);
    console.error(error);
  } finally {
    if (audio !== null && audio.state !== 'closed') await audio.close();
    running = false;
    connect.disabled = false;
    choose.disabled = false;
    noCanvas.disabled = false;
    play.disabled = false;
  }
});
