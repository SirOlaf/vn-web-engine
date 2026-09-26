import test from 'node:test';
import assert from 'node:assert/strict';
import {MountedFileSystem, StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaMemorySpeakerBackend} from '../dist/engines/buriko/games/aokana/native/audio/speaker-backend.js';
import {AokanaBpDiagnostics} from '../dist/engines/buriko/games/aokana/native/diagnostics.js';
import {AokanaMountedFileMetadata} from '../dist/engines/buriko/games/aokana/native/file-metadata.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {AokanaProgramMedia} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaProductionDataOwners} from '../dist/engines/buriko/games/aokana/native/production-data-owners.js';
import {AokanaProductionDisplayResourceGraph} from '../dist/engines/buriko/games/aokana/native/production-display-resource-graph.js';
import {AokanaProductionVmCore} from '../dist/engines/buriko/games/aokana/native/production-vm-core.js';
import {AokanaVmFrameHistory} from '../dist/engines/buriko/games/aokana/native/system-timing.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.style = {};
    this.listeners = new Map();
    this.children = [];
  }
  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }
  removeEventListener(name, listener) {
    if (this.listeners.get(name) === listener) this.listeners.delete(name);
  }
  append(child) {
    this.children.push(child);
  }
  setAttribute(name, value) {
    this[name] = value;
  }
  getBoundingClientRect() {
    return {left: 0, top: 0, right: 800, bottom: 600};
  }
  getContext() {
    assert.fail('frame-history fixture must not initialize a display device');
  }
  focus() {}
  remove() {}
}

test('production VM retains one frame-history ring seeded before root construction', async () => {
  const backing = new MountedFileSystem();
  backing.mount('/game', new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase()));
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
      {native: 'D:\\Drops', mounted: '/drops'},
    ],
    'C:\\game',
  );
  const text = new AokanaNativeText();
  const encode = (value) => text.encodeWide(value, 1);
  const document = {createElement: (tag) => new Element(tag)};
  let milliseconds = 100;
  const graph = new AokanaProductionDisplayResourceGraph({
    document,
    parent: document.createElement('div'),
    canvas: document.createElement('canvas'),
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
    preferredDialogTitle: null,
    cursorResource: null,
    performance: {now: () => milliseconds},
    readSystemTime: () => new Date(Date.UTC(2026, 8, 19, 12, 34, 56)),
    cpuHost: {
      cpuid: () => [0, 0, 0, 0],
      readTimestampCounter: () => 0n,
      setCurrentThreadAffinity: () => 1n,
      logicalProcessorCount: () => 1,
      logicalProcessorInformation: () => [{relationship: 0, processorMask: 1n}],
    },
    registryStore: new MemoryStore(),
    specialFolderProfile: {
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
    readUserDefaultUiLanguage: () => 0x409,
    localizedText: null,
    processorCount: 1,
    executablePathWide: 'C:\\game\\aokana.exe',
    commandLineTailWide: '   ',
    drop: {mountedRoot: '/drops', nativeRoot: 'D:\\Drops'},
    resource: {
      mounted,
      paths,
      media: new AokanaProgramMedia(),
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
      resourceWorkerCount: 1,
      sleep: async () => {},
    },
  });
  let core;
  try {
    const data = new AokanaProductionDataOwners(graph, new AokanaBpMemory(new Uint8Array(4096)));
    core = new AokanaProductionVmCore(graph, data, new AokanaBpDiagnostics(() => {}));
    const history = core.frameHistory;
    assert.ok(history instanceof AokanaVmFrameHistory);
    assert.equal(core.frameHistory, history);
    assert.equal(core.scheduler.root.state, core.root);
    assert.equal(
      core.fragments
        .nativeDefinitions()
        .some((slot) => slot.primary === 0x80 && slot.secondary === 3),
      false,
    );

    const bytes = new Uint8Array(8);
    const output = {bytes, offset: 0};
    milliseconds = 107;
    history.record(Number(graph.clock.read()));
    assert.equal(history.copy(output, 2), 1);
    assert.deepEqual([...new Uint32Array(bytes.buffer)], [7, 0]);
    history.clear();
    assert.equal(core.frameHistory, history);
    history.copy(output, 2);
    assert.deepEqual([...new Uint32Array(bytes.buffer)], [0, 0]);
    milliseconds = 111;
    history.record(Number(graph.clock.read()));
    history.copy(output, 2);
    assert.deepEqual([...new Uint32Array(bytes.buffer)], [4, 0]);
  } finally {
    if (core !== undefined) core.root.disposeStorage();
    await graph.shutdown();
  }
});
