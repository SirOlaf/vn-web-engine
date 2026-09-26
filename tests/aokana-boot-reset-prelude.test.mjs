import test from 'node:test';
import assert from 'node:assert/strict';
import {MountedFileSystem, StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaProductionDisplayResourceGraph} from '../dist/engines/buriko/games/aokana/native/production-display-resource-graph.js';
import {AokanaMountedFileMetadata} from '../dist/engines/buriko/games/aokana/native/file-metadata.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {AokanaProgramMedia} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaMemorySpeakerBackend} from '../dist/engines/buriko/games/aokana/native/audio/speaker-backend.js';
import {AokanaBpThread} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpScheduler} from '../dist/engines/buriko/games/aokana/bp/scheduler.js';
import {AokanaBootTerminationGate} from '../dist/engines/buriko/games/aokana/native/boot-termination-gate.js';
import {AokanaBootResetPrelude} from '../dist/engines/buriko/games/aokana/native/boot-reset-prelude.js';

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.style = {};
    this.children = [];
    this.listeners = new Map();
    this.disabled = false;
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
    return {left: 0, top: 0, right: 400, bottom: 300};
  }
  getContext() {
    assert.fail('reset prelude must not initialize or render the display device');
  }
  focus() {}
  remove() {}
}

test('ECB90 initial reset prefix and audio continuation use one live graph', async () => {
  const backing = new MountedFileSystem();
  backing.mount('/game', new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase()));
  const mounted = new AokanaMountedFileMetadata(backing, {
      records: [],
      volumes: [{path: '/', identity: {}, writable: true}],
      canonical: (path) => path.toLowerCase(),
      currentFileTime: () => 123n,
      accessTimePolicy: 'disabled',
    }),
    paths = new AokanaMountedProgramPaths(
      [
        {native: 'C:\\game', mounted: '/game'},
        {native: 'D:\\Drops', mounted: '/drops'},
      ],
      'C:\\game',
    ),
    text = new AokanaNativeText(),
    encode = (value) => text.encodeWide(value, 1),
    document = {createElement: (tag) => new Element(tag)},
    parent = document.createElement('div'),
    canvas = document.createElement('canvas'),
    graph = new AokanaProductionDisplayResourceGraph({
      document,
      parent,
      canvas,
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
      damageCapacity: 64,
      childMetrics: {
        frameWidth: 0,
        frameHeight: 0,
        verticalScrollbarWidth: 0,
        horizontalScrollbarHeight: 0,
      },
      nativeWindowTitle: encode('Aokana'),
      preferredDialogTitle: null,
      cursorResource: null,
      performance: {now: () => 0},
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
  const scheduler = new AokanaBpScheduler(
      new AokanaBpThread({id: 1, operandCapacity: 0, moduleCapacity: 0, frameCapacity: 0}),
    ),
    gate = new AokanaBootTerminationGate(scheduler, graph.resource.loading),
    prelude = new AokanaBootResetPrelude(graph, gate),
    keyList = new Uint8Array(8),
    preloadName = Uint8Array.of(0x62, 0x6d, 0x70, 0);
  new DataView(keyList.buffer).setUint32(0, 0x41, true);
  try {
    await graph.start({automatic: false});
    graph.host.setClosePolicy(0);
    assert.equal(graph.host.closeMenuEnabled, false);
    assert.equal(graph.controller.configureModeToggle(1, {bytes: keyList, offset: 0}), 1);
    assert.equal(graph.controller.containsModeToggleKey(0x41), true);
    graph.display.presentationEnabled = 0;
    graph.frames.setFrameFrequency(100);
    graph.display.frameDeadline = 77;
    graph.surfaces.preserveImageIds = 1;
    graph.resource.loading.preloaded.insert(null, preloadName, Uint8Array.of(7, 8));
    graph.resource.channels.streamMaster[0] = 37;
    graph.resource.channels.staticMaster[127] = 83;
    graph.resource.channels.staticHeaders.fill(0xa5);
    graph.resource.channels.staticHeadersInitialized.fill(0);

    assert.equal(gate.restartRequested, true);
    assert.equal(prelude.run(), 'reset-prefix-complete');
    assert.equal(gate.restartRequested, false);
    assert.equal(graph.host.closePolicy, 1);
    assert.equal(graph.host.closeMenuEnabled, true);
    assert.equal(graph.controller.containsModeToggleKey(0x41), false);
    assert.equal(graph.display.presentationEnabled, 1);
    assert.equal(graph.display.frameInterval, 4);
    assert.equal(graph.display.frameDeadline, 0);
    assert.equal(graph.surfaces.preserveImageIds, 0);
    assert.equal(graph.resource.loading.preloaded.read(null, preloadName), null);
    assert.equal(prelude.run(), null);
    assert.equal(await prelude.resetAudio(), 'audio-reset-complete');
    assert.ok(graph.resource.channels.streamMaster.every((value) => value === 128));
    assert.ok(graph.resource.channels.staticMaster.every((value) => value === 128));
    assert.ok(graph.resource.channels.staticHeaders.every((value) => value === 0));
    assert.ok(graph.resource.channels.staticHeadersInitialized.every((value) => value === 1));
  } finally {
    await graph.shutdown();
  }
});
