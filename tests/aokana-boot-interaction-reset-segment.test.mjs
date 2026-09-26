import test from 'node:test';
import assert from 'node:assert/strict';
import {MountedFileSystem, StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoProductionDisplayResourceGraph} from '../dist/engines/buriko/native/production-display-resource-graph.js';
import {BurikoMountedFileMetadata} from '../dist/engines/buriko/native/file-metadata.js';
import {BurikoMountedProgramPaths} from '../dist/engines/buriko/native/program-paths.js';
import {BurikoProgramMedia} from '../dist/engines/buriko/native/program-files.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoMemorySpeakerBackend} from '../dist/engines/buriko/native/audio/speaker-backend.js';
import {BurikoBpThread} from '../dist/engines/buriko/bp/state.js';
import {BurikoBootInteractionResetSegment} from '../dist/engines/buriko/native/boot-interaction-reset-segment.js';

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
    assert.fail('interaction reset fixture must not initialize or render the display device');
  }
  focus() {}
  remove() {}
}

test('ECB90 interaction segment clears the shared Knob, Sprite, input and wait owners', async () => {
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
    canvas = document.createElement('canvas'),
    graph = new BurikoProductionDisplayResourceGraph({
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
    const segment = new BurikoBootInteractionResetSegment(graph),
      spriteHandle = graph.manager.createSprite(),
      sprite = graph.manager.find('sprite', spriteHandle);
    assert.ok(sprite);
    assert.equal(sprite.configureGeometry(8, 8), 1);
    sprite.move(8, 8);
    assert.equal(graph.spriteTargets.register(spriteHandle), true);
    assert.equal(graph.spriteTargets.readState(0), 0);

    const knob = graph.knobs.create(spriteHandle);
    assert.equal(knob.result, 0);
    assert.equal(graph.knobs.registerWheel(knob.handle), true);
    graph.knobs.exchangeWheelMode(7);
    const knobObject = graph.manager.find('knob', knob.handle),
      before = graph.input.captureDiagnosticView();
    assert.ok(before.pointer.some((entry) => entry.object === sprite));
    assert.ok(before.pointer.some((entry) => entry.object === knobObject));

    const waitingThread = new BurikoBpThread({
      id: 1,
      operandCapacity: 0,
      moduleCapacity: 0,
      frameCapacity: 0,
    });
    graph.waits.register(waitingThread, 0x204);
    graph.waits.dispatch(0x204, 11n, 22n);
    assert.equal(graph.waits.consume(waitingThread, 0x204).received, true);
    assert.equal(graph.receiver.waits, graph.waits);
    assert.equal(graph.receiver.knobs, graph.knobs);
    assert.equal(graph.spriteTargets.manager, graph.manager);
    assert.equal(graph.spriteTargets.input, graph.input);

    assert.equal(segment.run(), 'interaction-reset-segment-complete');
    assert.equal(graph.knobs.wheelModeValue(), 1);
    assert.equal(graph.knobs.handleWheel(0), false);
    assert.equal(graph.knobs.currentPointerId(), 0);
    assert.equal(graph.spriteTargets.readState(0), null);
    assert.deepEqual(
      graph.input.captureDiagnosticView().pointer.map((entry) => [entry.token, entry.object]),
      [[1, null]],
    );
    assert.deepEqual(
      graph.input.captureDiagnosticView().key.map((entry) => [entry.token, entry.object]),
      [[1, null]],
    );
    assert.equal(graph.waits.consume(waitingThread, 0x204), null);
    graph.waits.register(waitingThread, 0x204);
    graph.waits.dispatch(0x204, 33n, 44n);
    assert.equal(graph.waits.consume(waitingThread, 0x204).received, true);
    assert.equal(graph.spriteTargets.register(spriteHandle), true);
    assert.equal(graph.spriteTargets.readState(0), 0);
  } finally {
    await graph.shutdown();
  }
});
