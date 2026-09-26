import test from 'node:test';
import assert from 'node:assert/strict';
import {MountedFileSystem, StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoProductionDisplayResourceGraph} from '../dist/engines/buriko/native/production-display-resource-graph.js';
import {BurikoWindowDisplayObject} from '../dist/engines/buriko/native/display-window.js';
import {BurikoRainDisplayState} from '../dist/engines/buriko/native/display-rain.js';
import {BurikoRainDisplays} from '../dist/engines/buriko/native/rain-displays.js';
import {BurikoCrtRandom} from '../dist/engines/buriko/native/system-timing.js';
import {BurikoMountedFileMetadata} from '../dist/engines/buriko/native/file-metadata.js';
import {BurikoMountedProgramPaths} from '../dist/engines/buriko/native/program-paths.js';
import {BurikoProgramMedia} from '../dist/engines/buriko/native/program-files.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoMemorySpeakerBackend} from '../dist/engines/buriko/native/audio/speaker-backend.js';

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.style = {};
    this.children = [];
    this.listeners = new Map();
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
    assert.fail('size-effects fixture must not initialize or render the display device');
  }
  focus() {}
  remove() {}
}

test('0802B0 resets the shared display manager and Window state while retaining Rain', async () => {
  const backing = new MountedFileSystem();
  backing.mount('/game', new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase()));
  const mounted = new BurikoMountedFileMetadata(backing, {
      records: [],
      volumes: [{path: '/', identity: {}, writable: true}],
      canonical: (path) => path.toLowerCase(),
      currentFileTime: () => 123n,
      accessTimePolicy: 'disabled',
    }),
    paths = new BurikoMountedProgramPaths(
      [
        {native: 'C:\\game', mounted: '/game'},
        {native: 'D:\\Drops', mounted: '/drops'},
      ],
      'C:\\game',
    ),
    text = new BurikoNativeText(),
    encode = (value) => text.encodeWide(value, 1),
    document = {createElement: (tag) => new Element(tag)},
    parent = document.createElement('div'),
    canvas = document.createElement('canvas');
  const graph = new BurikoProductionDisplayResourceGraph({
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
    nativeWindowTitle: encode('Buriko'),
    preferredDialogTitle: null,
    cursorResource: null,
    performance: {now: () => 100},
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
      media: new BurikoProgramMedia(),
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
      backend: new BurikoMemorySpeakerBackend(1000),
      output: {prefer24Bit: false},
      resourceWorkerCount: 1,
      sleep: async () => {},
    },
  });
  try {
    const {manager, windowState} = graph,
      rain = new BurikoRainDisplays(
        manager,
        new BurikoRainDisplayState(),
        new BurikoCrtRandom(),
        graph.ticks,
      ),
      spriteHandle = manager.createSprite(),
      windowCreated = manager.createConfigured(
        'window',
        (order) => new BurikoWindowDisplayObject(windowState, order),
        (object) => object.configureInitial(16, 16),
      ),
      rainCreated = rain.create(8, 8);
    assert.equal(windowCreated.result, 0);
    assert.equal(rainCreated.result, 0);
    const rainObject = rain.find(rainCreated.handle);
    assert.ok(rainObject);
    windowState.set(1, 128);
    manager.setBackdropActivation(0, 1);
    manager.setReferencePoint(17, 19);
    manager.setOrigin(3, 4);
    manager.setMinimumLayer(9);
    const seen = [],
      wrap = (owner, method, name) => {
        const original = owner[method].bind(owner);
        owner[method] = (...args) => {
          seen.push(name ?? `${method}:${args.join(',')}`);
          return original(...args);
        };
      };
    wrap(manager, 'clearDamage');
    wrap(manager, 'clearObjectLists');
    wrap(manager.lists, 'insert', 'insert-backdrop');
    wrap(manager, 'setBackdropActivation');
    wrap(manager, 'clearPool');
    wrap(windowState, 'set', 'window-state');
    wrap(manager, 'invalidateScene');
    wrap(manager, 'setReferencePoint');
    wrap(manager, 'setOrigin');
    wrap(manager, 'setMinimumLayer');

    manager.resetForProgram(windowState);
    assert.deepEqual(seen, [
      'clearDamage:',
      'clearObjectLists:',
      'insert-backdrop',
      'setBackdropActivation:1,0',
      'clearPool:sprite',
      'clearPool:filter',
      'clearPool:effector',
      'clearPool:map',
      'clearPool:landscape',
      'clearPool:window',
      'clearPool:particle',
      'clearPool:knob',
      'clearPool:group',
      'window-state',
      'invalidateScene:',
      'setReferencePoint:-1,-1',
      'setOrigin:0,0',
      'setMinimumLayer:0',
    ]);
    assert.equal(graph.windowState, windowState);
    assert.equal(windowState.manager, manager);
    assert.deepEqual([windowState.enabled, windowState.transparency], [0, 0]);
    assert.equal(manager.find('sprite', spriteHandle), null);
    assert.equal(manager.find('window', windowCreated.handle), null);
    assert.equal(rain.find(rainCreated.handle), rainObject);
    assert.equal(manager.createSprite(), spriteHandle);
    assert.deepEqual(manager.referencePoint, {x: -1, y: -1});
    assert.deepEqual(manager.environment.origin, {x: 0, y: 0});
    assert.equal(manager.minimumKey, 0);
    assert.deepEqual([manager.backdropActivation, manager.backdropContentEnabled], [1, 0]);
  } finally {
    await graph.shutdown();
  }
});
