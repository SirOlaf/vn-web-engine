import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBitmapStorage} from '../dist/engines/buriko/native/bitmap.js';
import {BurikoGpuTargetStorage} from '../dist/engines/buriko/native/bitmap-gpu-target.js';
import {blendBurikoAlphaIntoRgb} from '../dist/engines/buriko/native/bitmap-alpha.js';
import {clearBurikoBitmap} from '../dist/engines/buriko/native/bitmap-copy.js';
import {screenBurikoBitmap} from '../dist/engines/buriko/native/bitmap-effects.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {
  BurikoDisplayObject,
  BurikoDisplayObjectEnvironment,
} from '../dist/engines/buriko/native/display-object.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {BurikoDisplayRenderer} from '../dist/engines/buriko/native/display-renderer.js';
import {BurikoDisplayTexture} from '../dist/engines/buriko/native/display-texture.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {rasterTextBitmap, readRasterText, recordRasterText} from '../dist/text/raster-text.js';

function fakeTarget() {
  const target = {
    calls: [],
    failures: [],
    dispatch(kernel, args) {
      target.calls.push([kernel, args]);
      return 0;
    },
    fail(reason) {
      target.failures.push(reason);
    },
  };
  return target;
}

const bitmap = (storage, width = 2, height = 1, format = 1) => ({
  storage,
  offset: 0,
  stride: width * 4,
  width,
  height,
  format,
  bytesPerPixel: 4,
});

test('storage generations count every pixel access that could write', () => {
  const storage = new BurikoBitmapStorage(new Uint8Array(16), true);
  const next = (change) => {
    const before = storage.generation;
    change();
    return storage.generation - before;
  };
  assert.ok(next(() => storage.bytes) > 0);
  assert.ok(next(() => storage.view) > 0);
  assert.ok(next(() => storage.initializedView(0, 4)) > 0);
  assert.ok(next(() => storage.written(0, 4)) > 0);
  assert.ok(next(() => storage.range(0, 4, false)) > 0);
  assert.equal(
    next(() => storage.range(0, 4, true)),
    0,
  );
  assert.equal(
    next(() => storage.readOnlyBytes()),
    0,
  );
  assert.equal(
    next(() => storage.isInitialized(0, 16)),
    0,
  );
  assert.equal(storage.byteLength, 16);
  assert.ok(next(() => storage.release()) > 0);
});

test('kernels on a GPU display target dispatch by their GPU id without touching pixels', () => {
  const software = new BurikoBitmapStorage(new Uint8Array(8), true);
  const target = fakeTarget();
  const destination = bitmap(new BurikoGpuTargetStorage(target, software));
  const source = bitmap(new BurikoBitmapStorage(new Uint8Array(8).fill(0xff), true), 2, 1, 2);
  blendBurikoAlphaIntoRgb(destination, source);
  clearBurikoBitmap(destination);
  screenBurikoBitmap(destination, source, 128, false);
  assert.deepEqual(
    target.calls.map(([kernel]) => kernel),
    ['alpha-into-rgb', 'clear', undefined],
  );
  assert.equal(target.calls[0][1][0], destination);
  assert.equal(target.calls[0][1][1], source);
  assert.deepEqual(target.failures, []);
  assert.deepEqual([...software.readOnlyBytes()], new Array(8).fill(0));
  // Software destinations keep the software kernels.
  const plain = bitmap(new BurikoBitmapStorage(new Uint8Array(8), true));
  blendBurikoAlphaIntoRgb(plain, source);
  // An opaque pair copies both source pixels whole.
  assert.equal(plain.storage.view.getUint32(0, true), 0xffffffff);
  assert.equal(target.calls.length, 3);
});

test('textless GPU frames replay each kernel with textless sources and record its text', () => {
  const software = new BurikoBitmapStorage(new Uint8Array(32), true);
  const target = fakeTarget();
  let plane = 'native';
  Object.assign(target, {
    textless: true,
    replay(run) {
      plane = 'textless';
      run();
      plane = 'native';
    },
  });
  const dispatch = target.dispatch;
  target.dispatch = (kernel, args) => dispatch(kernel, [...args, plane]);
  const destination = bitmap(new BurikoGpuTargetStorage(target, software), 4, 2);
  const glyph = bitmap(new BurikoBitmapStorage(new Uint8Array(8).fill(0xff), true), 2, 1, 2);
  recordRasterText(glyph, 'A', {size: 1, width: 2});
  blendBurikoAlphaIntoRgb(destination, glyph);
  assert.deepEqual(
    target.calls.map(([kernel, args]) => [kernel, args.at(-1)]),
    [
      ['alpha-into-rgb', 'native'],
      ['alpha-into-rgb', 'textless'],
    ],
  );
  assert.equal(target.calls[0][1][1], glyph);
  assert.equal(target.calls[1][1][1].storage, rasterTextBitmap(glyph).storage);
  assert.notEqual(rasterTextBitmap(glyph).storage, glyph.storage);
  // The text is recorded on the software display storage, whose bytes stay untouched.
  assert.deepEqual(
    readRasterText({...destination, storage: software}).map((g) => g.text),
    ['A'],
  );
  assert.deepEqual([...software.readOnlyBytes()], new Array(32).fill(0));
  assert.deepEqual(target.failures, []);
});

test('direct access to the stand-in storage fails the frame and reaches software bytes', () => {
  const software = new BurikoBitmapStorage(new Uint8Array(8), true);
  const target = fakeTarget();
  const stand = new BurikoGpuTargetStorage(target, software);
  assert.equal(stand.bytes, software.readOnlyBytes());
  stand.view.setUint32(4, 0x01020304, true);
  assert.equal(stand.initializedView(0, 8), software.view);
  stand.written(0, 4);
  stand.range(0, 4, true);
  stand.release();
  assert.deepEqual(target.failures, [
    'bytes',
    'view',
    'initializedView',
    'written',
    'range',
    'release',
  ]);
  assert.equal(software.view.getUint32(4, true), 0x01020304);
});

function setup() {
  const compositor = new BurikoBitmapCompositor();
  const environment = new BurikoDisplayObjectEnvironment(
    compositor,
    new BurikoDisplayDamage(64, {left: 0, top: 0, right: 3, bottom: 3}),
  );
  const allocator = new BurikoDistributedAllocator(1);
  const surfaces = new BurikoSurfaces(
    new BurikoNativeFonts(new BurikoNativeText()),
    compositor,
    allocator,
  );
  const manager = new BurikoDisplayManager(
    environment,
    surfaces,
    new BurikoNativeDisplayState(1920, 1080),
  );
  new BurikoDisplayRenderer(manager, 16);
  manager.configureDescriptor(4, 3, 1, 12);
  const texture = new BurikoDisplayTexture(8, 4, 22);
  texture.clearLogical(4, 3);
  manager.setDisplayTexture(texture);
  return {environment, manager, texture};
}

/** GPU frames that publish a stand-in storage and fail when a kernel touches pixels. */
function gpuFrames(manager) {
  const target = fakeTarget(),
    log = [];
  let stand = null,
    software = null;
  manager.gpuFrames = {
    begin(context, bounds) {
      log.push(['begin', {...bounds}]);
      software = context.bitmap.storage;
      stand = new BurikoGpuTargetStorage(target, software);
      target.failures.length = 0;
      context.bitmap.storage = stand;
      return true;
    },
    end(context) {
      context.bitmap.storage = software;
      log.push(['end', target.failures.length === 0]);
      return target.failures.length === 0;
    },
    prepareSoftware() {
      log.push(['software']);
    },
  };
  return {target, log};
}

test('GPU frames draw once, and a failed GPU frame reruns the same jobs in software', () => {
  for (const direct of [false, true]) {
    const {environment, manager, texture} = setup();
    const {target, log} = gpuFrames(manager);
    const draws = [],
      notifications = [];
    class Drawn extends BurikoDisplayObject {
      draw(destination) {
        const gpu = destination.storage !== texture.storage;
        draws.push(gpu);
        if (direct) destination.storage.bytes.fill(7, destination.offset, destination.offset + 4);
        else clearBurikoBitmap(destination);
      }
      notify() {
        notifications.push(environment.displayContext.bitmap.storage === texture.storage);
      }
    }
    manager.createSimple('sprite', (order) => {
      const object = new Drawn(environment, 1, order, 1);
      object.configureGeometry(4, 3);
      object.setActivation(1);
      return object;
    });
    assert.equal(manager.drawFull(), 1);
    // One job covers the whole display even though the native budget would strip it.
    assert.deepEqual(log[0], ['begin', {left: 0, top: 0, right: 3, bottom: 2}]);
    if (direct) {
      assert.deepEqual(draws, [true, false]);
      assert.deepEqual(log.slice(1), [['end', false], ['software']]);
      assert.equal(texture.storage.view.getUint32(0, true), 0x07070707);
    } else {
      assert.deepEqual(draws, [true]);
      assert.deepEqual(log.slice(1), [['end', true]]);
      assert.deepEqual(
        target.calls.map(([kernel]) => kernel),
        // The default backdrop clears, then the object.
        ['clear', 'clear'],
      );
    }
    assert.deepEqual(notifications, [true]);
    assert.equal(environment.displayContext.bitmap.storage, null);
  }
});

/** A pending write that fills its destination with a value when settled. */
function pendingFill(destination, sources, value, log) {
  const write = {
    settle() {
      write.discard();
      log.push(['settle', value]);
      destination.bytes.fill(value);
    },
    discard() {
      log.push(['discard', value]);
      destination.detach(write, sources);
    },
  };
  return write;
}

test('pending writes settle on pixel access and before their sources change', () => {
  const log = [];
  const source = new BurikoBitmapStorage(new Uint8Array(4), true),
    destination = new BurikoBitmapStorage(new Uint8Array(4), false);
  const write = pendingFill(destination, [source], 9, log);
  const before = destination.generation;
  destination.defer(write, [source], () => false, [[0, 4]]);
  assert.ok(destination.generation > before);
  assert.equal(destination.pending, write);
  // Checks that never read pixels leave the write pending.
  assert.equal(destination.isInitialized(0, 4), true);
  destination.backing();
  source.readOnlyBytes();
  source.range(0, 4, true);
  assert.deepEqual(log, []);
  // A source write settles its readers first.
  source.view.setUint32(0, 1, true);
  assert.deepEqual(log, [
    ['discard', 9],
    ['settle', 9],
  ]);
  assert.equal(destination.pending, null);
  assert.deepEqual([...destination.readOnlyBytes()], [9, 9, 9, 9]);

  // Reading the destination settles it; release drops an unobserved write.
  log.length = 0;
  destination.defer(pendingFill(destination, [source], 5, log), [source], () => false, []);
  destination.range(0, 4, true);
  assert.deepEqual(log.at(-1), ['settle', 5]);
  log.length = 0;
  destination.defer(pendingFill(destination, [source], 6, log), [source], () => false, []);
  destination.release();
  assert.deepEqual(log, [['discard', 6]]);
  // The discarded write no longer reads its source.
  source.bytes;
  assert.deepEqual(log, [['discard', 6]]);
});

test('a pending write replaced whole is discarded, otherwise settled first', () => {
  const log = [];
  const source = new BurikoBitmapStorage(new Uint8Array(4), true),
    destination = new BurikoBitmapStorage(new Uint8Array(4), true);
  destination.defer(pendingFill(destination, [source], 1, log), [source], () => false, []);
  destination.defer(pendingFill(destination, [source], 2, log), [source], () => true, []);
  assert.deepEqual(log, [['discard', 1]]);
  destination.defer(pendingFill(destination, [source], 3, log), [source], () => false, []);
  assert.deepEqual(log.slice(1), [
    ['discard', 2],
    ['settle', 2],
  ]);
  assert.deepEqual([...destination.bytes], [3, 3, 3, 3]);
});
