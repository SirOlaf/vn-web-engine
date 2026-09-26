import test from 'node:test';
import assert from 'node:assert/strict';
import {MountedFileSystem, StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoProductionDisplayResourceGraph} from '../dist/engines/buriko/native/production-display-resource-graph.js';
import {BurikoBootInputNotificationResetSegment} from '../dist/engines/buriko/native/boot-input-notification-reset-segment.js';
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

test('ECB90 notification and input reset uses the graph owners in native order', async () => {
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
    }),
    segment = new BurikoBootInputNotificationResetSegment(graph),
    seen = [];
  try {
    graph.notifications.push(0x42, 7, 8);
    graph.input.recordKeyDown(0x41);
    graph.input.exchangeKeyOption(0x41, 9);
    graph.input.mouseButtonMode = 1;
    const clearNotifications = graph.notifications.clear.bind(graph.notifications),
      clearKeys = graph.input.clearAllKeyRecords.bind(graph.input);
    graph.notifications.clear = () => {
      seen.push(`notifications-before-key-${graph.input.totalPresses(0x41)}`);
      clearNotifications();
    };
    graph.input.clearAllKeyRecords = () => {
      seen.push(`keys-after-notifications-${graph.notifications.take() === null}`);
      seen.push(`keys-before-mode-${graph.input.mouseButtonMode}`);
      clearKeys();
    };
    assert.equal(segment.run(), 'input-notification-reset-segment-complete');
    assert.deepEqual(seen, [
      'notifications-before-key-1',
      'keys-after-notifications-true',
      'keys-before-mode-1',
    ]);
    assert.equal(graph.notifications.take(), null);
    assert.equal(graph.input.totalPresses(0x41), 0);
    assert.equal(graph.input.keyOption(0x41), 0);
    assert.equal(graph.input.mouseButtonMode, 0);
    assert.equal(graph.receiver.notifications, graph.notifications);
    assert.equal(graph.receiver.input, graph.input);
  } finally {
    await graph.shutdown();
  }
});
