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

test('queued initialized WM_SIZE joins shared effects before its menu and input tail', async () => {
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
  let now = 100;
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
      performance: {now: () => now},
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
    channels = graph.resource.channels,
    actor = {},
    seen = [];
  try {
    await graph.start({automatic: false});
    // The eventual complete C3900 owner publishes this bit after ordered startup.
    graph.initialized.completeStartup(1, () => 1);
    assert.equal(await channels.setPersistentMaster(true, 0, 37, actor), 1);
    assert.equal(await channels.setPersistentMaster(false, 127, 83, actor), 1);
    graph.host.applySizeMenuTail(0, graph.input);
    graph.clock.setPauseOption(1);
    assert.equal(graph.input.inputActive, true);

    // Observe each real owner at the handoff; the wrapped methods still perform their work.
    const mute = channels.mute.bind(channels),
      setSuppression = graph.traditionalMovieAudio.setSuppression.bind(graph.traditionalMovieAudio),
      applyWindowSuppression = graph.mfMovieVolume.applyWindowSuppression.bind(graph.mfMovieVolume),
      beginSuspension = graph.clock.beginSuspension.bind(graph.clock);
    channels.mute = async (callActor) => {
      assert.equal(callActor, actor);
      await mute(callActor);
      seen.push('mute-complete');
    };
    graph.traditionalMovieAudio.setSuppression = (value) => {
      seen.push(`suppression-after-muted-${channels.muted}`);
      return setSuppression(value);
    };
    graph.mfMovieVolume.applyWindowSuppression = (value) => {
      seen.push(`mf-after-traditional-${graph.traditionalMovieAudio.rawSuppression}`);
      return applyWindowSuppression(value);
    };
    graph.clock.beginSuspension = (force) => {
      seen.push(`clock-before-tail-${graph.input.inputActive}`);
      return beginSuspension(force);
    };

    assert.equal(graph.queuedDispatcher.size, graph.queuedSize);
    assert.equal(graph.queuedSize.effects, graph.sizeEffects);
    graph.messages.post({target: 'main', message: 5, wParam: 1, lParam: 0});
    const dispatched = await graph.allocator.withActor(actor, () =>
      graph.queuedDispatcher.dispatchNext(),
    );
    assert.equal(dispatched.result, 0);
    assert.deepEqual(seen, [
      'mute-complete',
      'suppression-after-muted-1',
      'mf-after-traditional-1',
      'clock-before-tail-true',
    ]);
    assert.equal(channels.muted, 1);
    assert.equal(channels.streamMaster[0], 37);
    assert.equal(channels.staticMaster[127], 83);
    assert.equal(channels.stream[0].levels.master, 0);
    assert.equal(channels.static[127].levels.master, 0);
    assert.equal(graph.traditionalMovieAudio.rawSuppression, 1);
    assert.equal(graph.mfMovieVolume.savedVolume, 0);
    assert.equal(graph.input.inputActive, false);
    assert.equal(graph.input.iconic, 0);
    assert.equal(graph.input.scriptMinimizeLatch, 0);
    graph.messages.post({target: 'main', message: 5, wParam: 0, lParam: 0});
    assert.equal(
      (await graph.allocator.withActor(actor, () => graph.queuedDispatcher.dispatchNext())).result,
      0,
    );
    assert.equal(channels.muted, 0);
    assert.equal(graph.traditionalMovieAudio.rawSuppression, 0);
    assert.equal(graph.input.inputActive, true);
    now = 110;
    assert.equal(graph.clock.endSuspension(), true);
  } finally {
    await graph.shutdown();
  }
});
