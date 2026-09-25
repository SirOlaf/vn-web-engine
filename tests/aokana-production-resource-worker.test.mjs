import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaProductionResourceWorker} from '../dist/engines/buriko/games/aokana/native/production-resource-worker.js';
import {AokanaMountedFileMetadata} from '../dist/engines/buriko/games/aokana/native/file-metadata.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {AokanaProgramMedia} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaSystemTicks} from '../dist/engines/buriko/games/aokana/native/system-ticks.js';
import {AokanaNativeInput} from '../dist/engines/buriko/games/aokana/native/input.js';
import {AokanaWindowMessages} from '../dist/engines/buriko/games/aokana/native/window-messages.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayAdapters} from '../dist/engines/buriko/games/aokana/native/display-adapters.js';
import {AokanaDisplayDevice} from '../dist/engines/buriko/games/aokana/native/display-device.js';
import {AokanaBrowserMainWindow} from '../dist/engines/buriko/games/aokana/native/browser-main-window.js';
import {
  AokanaNativeCursor,
  AokanaEngineDialogs,
} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {AokanaDiagnosticDialogs} from '../dist/engines/buriko/games/aokana/native/modal.js';
import {AokanaMemorySpeakerBackend} from '../dist/engines/buriko/games/aokana/native/audio/speaker-backend.js';

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.style = {};
    this.children = [];
  }
  addEventListener() {}
  append(child) {
    this.children.push(child);
  }
  setAttribute(name, value) {
    this[name] = value;
  }
  focus() {}
  getContext() {
    assert.fail('resource worker fixture does not render');
  }
}

function wave() {
  const bytes = new Uint8Array(64 + 5000 * 2),
    view = new DataView(bytes.buffer);
  for (const [offset, value] of [
    [0, 64],
    [4, 0x20207762],
    [8, 10000],
    [12, 5000],
    [16, 1000],
    [20, 1],
    [48, 1],
  ])
    view.setUint32(offset, value, true);
  return bytes;
}

test('one production owner shares mounted resource, audio and script identities through worker startup and shutdown', async () => {
  const backing = new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase());
  await backing.commit([
    {kind: 'write', path: '/game/document', data: Uint8Array.of(11, 22, 33, 44)},
  ]);
  const mounted = new AokanaMountedFileMetadata(backing, {
      records: [
        {
          path: '/game/document',
          kind: 'file',
          attributes: 32,
          creationTime: null,
          accessTime: null,
          writeTime: 123n,
        },
      ],
      volumes: [{path: '/', identity: {}, writable: true}],
      canonical: (path) => path.toLowerCase(),
      currentFileTime: () => 123n,
      accessTimePolicy: 'disabled',
    }),
    paths = new AokanaMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\game'),
    text = new AokanaNativeText(),
    media = new AokanaProgramMedia(),
    allocator = new AokanaDistributedAllocator(1),
    display = new AokanaNativeDisplayState(16, 8),
    clock = new AokanaNativeClock(() => 0),
    ticks = new AokanaSystemTicks({now: () => 0}),
    input = new AokanaNativeInput(display, clock),
    messages = new AokanaWindowMessages(input),
    compositor = new AokanaBitmapCompositor(),
    manager = new AokanaDisplayManager(
      new AokanaDisplayObjectEnvironment(
        compositor,
        new AokanaDisplayDamage(64, {left: 0, top: 0, right: 15, bottom: 7}),
      ),
      new AokanaSurfaces(null, compositor, allocator),
      display,
    ),
    document = {createElement: (tag) => new Element(tag)},
    parent = document.createElement('div'),
    canvas = document.createElement('canvas');
  display.monitors = [[0, 0, 16, 8]];
  messages.createMainTarget();
  const adapters = new AokanaDisplayAdapters(
      display,
      [
        {
          monitor: 0,
          pixelShaderVersion: 0,
          mode: {width: 16, height: 8, refreshRate: 60, format: 22},
        },
      ],
      0,
      () => [0, 0, 16, 8],
    ),
    device = new AokanaDisplayDevice(canvas, manager, clock, adapters),
    host = new AokanaBrowserMainWindow(document, parent, canvas, manager, {
      isReady: () => messages.mainTarget() !== null,
      presentTransient: () => 0,
      inlinePaintSuppressed: () => false,
      geometryChanged() {},
    }),
    dialogs = new AokanaEngineDialogs(
      new AokanaDiagnosticDialogs(document, parent),
      text,
      clock,
      input,
      new AokanaNativeCursor(canvas),
      device,
      display,
      null,
      Uint8Array.of(0),
    ),
    encode = (value) => text.encodeWide(value, 1),
    owner = new AokanaProductionResourceWorker({
      mounted,
      paths,
      text,
      media,
      dialogs,
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
      ticks,
      allocator,
      locks: manager.locks,
      resourceWorkerCount: 1,
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    });
  assert.equal(owner.files.metadata, mounted);
  assert.equal(owner.files.paths, paths);
  assert.equal(owner.resources.files, owner.files);
  assert.equal(owner.audio.loading, owner.loading);
  assert.equal(owner.scripts.actors, allocator);
  assert.equal(owner.channels.actors, manager.surfaces.allocator);
  assert.equal(owner.channels.locks, manager.locks);
  await owner.start(host, {automatic: false});
  try {
    assert.equal(owner.worker.isRunning, true);
    const output = {bytes: null},
      result = {value: 99};
    owner.loading.enqueueOwned(output, result, null, encode('document'));
    assert.equal(await owner.worker.processOne(), 'resource');
    assert.equal(result.value, 4);
    assert.deepEqual([...output.bytes], [11, 22, 33, 44]);

    const staticBytes = wave(),
      staticResult = {value: 99};
    owner.audio.enqueueStatic(
      staticResult,
      0,
      {bytes: staticBytes, offset: 0},
      0,
      1,
      1,
      new Uint8Array(staticBytes.length).fill(1),
    );
    assert.equal(await owner.worker.processOne(), 'static');
    assert.equal(staticResult.value, 0);

    const handle = {bytes: new Uint8Array(4), offset: 0};
    assert.equal(
      await owner.scripts.open(handle, {bytes: encode('C:\\game\\document'), offset: 0}, 0),
      0,
    );
    const id = new DataView(handle.bytes.buffer).getUint32(0, true),
      completion = {bytes: new Uint8Array(4), offset: 0},
      scriptBuffer = {bytes: new Uint8Array(4), offset: 0};
    assert.equal(await owner.scripts.queueTransfer(completion, id, scriptBuffer, 4), 0);
    assert.equal(await owner.worker.processOne(), 'script');
    assert.deepEqual([...scriptBuffer.bytes], [11, 22, 33, 44]);
    assert.equal(new DataView(completion.bytes.buffer).getUint32(0, true), 4);
  } finally {
    await owner.shutdown();
  }
  assert.equal(owner.worker.isRunning, false);
  assert.equal(owner.channels.flags, 0);
});
