import assert from 'node:assert/strict';
import {MountedFileSystem, StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaMemorySpeakerBackend} from '../dist/engines/buriko/games/aokana/native/audio/speaker-backend.js';
import {AokanaBpDiagnostics} from '../dist/engines/buriko/games/aokana/native/diagnostics.js';
import {updateNativeChecksum} from '../dist/engines/buriko/games/aokana/native/group-81-hash.js';
import {AokanaMountedFileMetadata} from '../dist/engines/buriko/games/aokana/native/file-metadata.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {AokanaProgramMedia} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaProductionDataOwners} from '../dist/engines/buriko/games/aokana/native/production-data-owners.js';
import {AokanaProductionDisplayResourceGraph} from '../dist/engines/buriko/games/aokana/native/production-display-resource-graph.js';
import {AokanaProductionVmCore} from '../dist/engines/buriko/games/aokana/native/production-vm-core.js';
import {AokanaProductionVmFragments} from '../dist/engines/buriko/games/aokana/native/production-vm-fragments.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {singleArchive} from './aokana-resource-direct-fixtures.mjs';

function checkedArchive(name, payload) {
  const archive = singleArchive(name, payload);
  const checksum = new Uint8Array(8);
  updateNativeChecksum({bytes: checksum, offset: 0}, {bytes: payload, offset: 0}, payload.length);
  new DataView(archive.buffer).setBigUint64(
    120,
    new DataView(checksum.buffer).getBigUint64(0, true),
    true,
  );
  return archive;
}

class Element {
  constructor(tag, onDialogShown) {
    this.tagName = tag.toUpperCase();
    this.onDialogShown = onDialogShown;
    this.style = {};
    this.listeners = new Map();
    this.children = [];
    this.value = '';
  }
  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }
  removeEventListener(name, listener) {
    if (this.listeners.get(name) === listener) this.listeners.delete(name);
  }
  append(...children) {
    for (const child of children) {
      this.children.push(child);
      child.parent = this;
    }
  }
  prepend(...children) {
    for (const child of children.reverse()) {
      this.children.unshift(child);
      child.parent = this;
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parent = null;
    this.children.length = 0;
    this.append(...children);
  }
  setAttribute(name, value) {
    this[name] = value;
  }
  getBoundingClientRect() {
    const left = Number.parseFloat(this.style.left) || 0;
    const top = Number.parseFloat(this.style.top) || 0;
    return {left, top, right: left + 800, bottom: top + 600};
  }
  getContext() {
    assert.fail('VM fixture must not initialize a display device');
  }
  showModal() {
    this.open = true;
    this.onDialogShown?.(this);
  }
  close() {
    this.open = false;
  }
  focus() {}
  select() {
    this.selectionStart = 0;
    this.selectionEnd = this.value.length;
  }
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  setRangeText(value, start, end) {
    this.value = this.value.slice(0, start) + value + this.value.slice(end);
    this.selectionStart = this.selectionEnd = start + value.length;
  }
  remove() {
    if (this.parent) {
      this.parent.children.splice(this.parent.children.indexOf(this), 1);
      this.parent = null;
    }
  }
}

// Each call owns a graph and VM. No browser device, renderer, media playback, or BP interpreter starts.
export async function createMountedVmFixture({
  boot = true,
  prepareRenderer = false,
  seedCoreArchives = false,
  resourceWorkerCount = 1,
  performanceNow = () => 0,
  readLocalTime,
  cpuHost = {
    cpuid: () => [0, 0, 0, 0],
    readTimestampCounter: () => 0n,
    setCurrentThreadAffinity: () => 1n,
    logicalProcessorCount: () => 1,
    logicalProcessorInformation: () => [{relationship: 0, processorMask: 1n}],
  },
  fontProvider,
  systemProfileHost,
  devicePowerHost,
  gamepadHost,
  displayEnumerationHost,
  childWindowCoordinates,
  childWindowParent,
  characterTranslationHost,
  engineCaption,
  temporaryFileHost,
  mountDriveC = false,
  canvas2dContext,
  presentationMode,
  cryptoRandom,
  namedMutexHost,
  pickerHost,
  shellShortcutHost,
  internetReadHost,
  cdMediaHost,
  installerDialogHost,
  taskbarProgressHost,
  surfaceMovieDocumentByteBudget,
  mfMovieDocumentByteBudget,
  externalProcessHost,
  shellExecuteHost,
  dynamicLibraryHost,
  logicalDriveHost,
  sleep = async () => {},
  touchProfile,
  desktopWallpaperHost,
  windowTransitionProfile,
  driveHost,
  driveGeometryHost,
  onDialogShown,
  specialFolderProfile = {
    shellAllocatorAvailable: false,
    windows: null,
    programFiles: null,
    currentUser: {desktop: null, programs: null, documents: null, profile: null},
    shellUser: {desktop: null, programs: null, documents: null, profile: null},
    elevated: false,
    shellTokenAvailable: false,
    debugPrivilegeAvailable: false,
    shellAccountName: null,
  },
} = {}) {
  const backing = new MountedFileSystem();
  backing.mount('/game', new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase()));
  backing.mount('/restart', new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase()));
  if (mountDriveC)
    backing.mount(
      '/drive-c',
      new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase()),
    );
  const mounted = new AokanaMountedFileMetadata(backing, {
    records: [],
    volumes: [{path: '/', identity: {}, writable: true}],
    canonical: (path) => path.toLowerCase(),
    currentFileTime: () => 123n,
    accessTimePolicy: 'disabled',
  });
  const paths = new AokanaMountedProgramPaths(
    [
      {native: 'C:\\game', mounted: '/game'},
      {native: 'C:\\restart', mounted: '/restart'},
      ...(mountDriveC ? [{native: 'C:\\', mounted: '/drive-c'}] : []),
      {native: 'D:\\Drops', mounted: '/drops'},
    ],
    'C:\\game',
  );
  const text = new AokanaNativeText();
  const encode = (value) => text.encodeWide(value, 1);
  const document = {
    createElement: (tag) => new Element(tag, onDialogShown),
    createTextNode: (value) => {
      const node = new Element('#text');
      node.textContent = value;
      return node;
    },
  };
  document.body = document.createElement('body');
  const canvas = document.createElement('canvas');
  if (canvas2dContext !== undefined) {
    canvas.context2d = canvas2dContext;
    canvas.getContext = (kind) => {
      assert.equal(kind, '2d');
      return canvas2dContext;
    };
  }
  const media = new AokanaProgramMedia();
  media.setDriveType(2, 3);
  const graph = new AokanaProductionDisplayResourceGraph({
    document,
    parent: document.createElement('div'),
    canvas,
    presentationMode,
    navigator: {},
    readViewportScreenMapping: () => ({
      originX: 0,
      originY: 0,
      nativePixelsPerCssX: 1,
      nativePixelsPerCssY: 1,
    }),
    monitors: [[0, 0, 800, 600]],
    selectedMonitor: 0,
    primaryMonitor: 0,
    clientOrigin: [0, 0],
    adapters: [
      {
        monitor: 0,
        pixelShaderVersion: 0,
        mode: {width: 800, height: 600, refreshRate: 60, format: 22},
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
    engineCaption,
    preferredDialogTitle: null,
    cursorResource: null,
    performance: {now: performanceNow},
    readSystemTime: () => new Date(Date.UTC(2026, 8, 19, 12, 34, 56)),
    readLocalTime,
    cpuHost,
    fontProvider,
    systemProfileHost,
    devicePowerHost,
    gamepadHost,
    displayEnumerationHost,
    childWindowCoordinates,
    childWindowParent,
    characterTranslationHost,
    cryptoRandom,
    namedMutexHost,
    pickerHost,
    shellShortcutHost,
    internetReadHost,
    cdMediaHost,
    installerDialogHost,
    taskbarProgressHost,
    surfaceMovieDocumentByteBudget,
    mfMovieDocumentByteBudget,
    externalProcessHost,
    shellExecuteHost,
    dynamicLibraryHost,
    logicalDriveHost,
    touchProfile,
    windowTransitionProfile,
    desktopWallpaperHost,
    registryStore: new MemoryStore(),
    specialFolderProfile,
    readUserDefaultUiLanguage: () => 0x409,
    localizedText: null,
    processorCount: 1,
    executablePathWide: 'C:\\game\\aokana.exe',
    commandLineTailWide: '. "Execute as a launcher."',
    drop: {mountedRoot: '/drops', nativeRoot: 'D:\\Drops'},
    resource: {
      mounted,
      paths,
      media,
      driveHost,
      driveGeometryHost,
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
      backend: new AokanaMemorySpeakerBackend(1000),
      output: {prefer24Bit: false},
      resourceWorkerCount,
      sleep,
      temporaryFileHost,
    },
  });
  let core;
  let child;
  let closing;
  const close = () => {
    closing ??= (async () => {
      try {
        if (core !== undefined) {
          await core.close();
        }
      } finally {
        await graph.shutdown();
      }
    })();
    return closing;
  };
  try {
    const module = new Uint8Array(12);
    const header = new DataView(module.buffer);
    header.setUint32(0, 8, true);
    header.setUint32(4, 4, true);
    module.set([0x11, 0x22, 0x33, 0x44], 8);
    await graph.resource.files.write(
      encode('C:\\game\\system.arc'),
      singleArchive('ipl._bp', module),
    );
    if (seedCoreArchives) {
      const resourcePayload = Uint8Array.of(41, 43, 47, 53, 59);
      await graph.resource.files.write(
        encode('C:\\game\\data.arc'),
        checkedArchive('entry', resourcePayload),
      );
      const restartModule = new Uint8Array(11);
      const restartHeader = new DataView(restartModule.buffer);
      restartHeader.setUint32(0, 8, true);
      restartHeader.setUint32(4, 3, true);
      restartModule.set([0x55, 0x66, 0x77], 8);
      await graph.resource.files.write(
        encode('C:\\restart\\next.arc'),
        singleArchive('next._bp', restartModule),
      );
    }
    await graph.launchSelection.configureFromCommandLine();
    if (prepareRenderer) graph.prepareRenderPixelBudget();
    const selectedArchive = new Uint8Array(784);
    const selectedModule = new Uint8Array(784);
    graph.launchSelection.copyBootNames(selectedArchive, selectedModule);
    const memory = new AokanaBpMemory(new Uint8Array(0x10000));
    const data = new AokanaProductionDataOwners(graph, memory);
    const diagnostics = new AokanaBpDiagnostics(() =>
      assert.fail('ordinary boot load must not report a write watch'),
    );
    core = new AokanaProductionVmCore(graph, data, diagnostics);
    const fragments = new AokanaProductionVmFragments(core);
    const definitions = fragments.nativeDefinitions();
    const bootChild = async () => {
      assert.equal(child, undefined, 'boot child already appended');
      const id = await core.loader.appendSelectedProgram(selectedArchive, selectedModule);
      child = core.scheduler.findById(id);
      assert.ok(child);
      return id;
    };
    const fixture = {
      graph,
      media,
      mounted,
      paths,
      text,
      encode,
      memory,
      data,
      diagnostics,
      core,
      fragments,
      definitions,
      selectedArchive,
      selectedModule,
      get child() {
        return child;
      },
      bootChild,
      async invoke(primary, secondary, args, status, actor) {
        assert.ok(child, 'boot child required to invoke a native callback');
        const definition = definitions.find(
          (entry) => entry.primary === primary && entry.secondary === secondary,
        );
        assert.ok(definition);
        for (const value of args) push32(child.state, value);
        assert.equal(
          await definition.execute({thread: child.state, memory, diagnostics, actor}),
          status,
        );
        return child.state.stackIndex;
      },
      close,
    };
    if (boot) await bootChild();
    return fixture;
  } catch (error) {
    try {
      await close();
    } catch {
      // Keep the construction error while still attempting ordered cleanup.
    }
    throw error;
  }
}
