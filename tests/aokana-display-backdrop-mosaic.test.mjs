import {bitmapWrite32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {BurikoMosaicBackdrop} from '../dist/engines/buriko/native/display-backdrop-mosaic.js';
import {createGroup90BackdropMosaic} from '../dist/engines/buriko/native/group-90-backdrop-mosaic.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoBitmapStorage} from '../dist/engines/buriko/native/bitmap.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {BurikoDisplayObjectEnvironment} from '../dist/engines/buriko/native/display-object.js';
import {BurikoDisplayRenderer} from '../dist/engines/buriko/native/display-renderer.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

const rectangle = (left, top, right, bottom) => ({left, top, right, bottom});
const bitmap = (width, height, values = []) => ({
  storage: new BurikoBitmapStorage(
    new Uint8Array(
      new Uint32Array(Array.from({length: width * height}, (_, index) => values[index] ?? 0))
        .buffer,
    ),
    true,
  ),
  offset: 0,
  stride: width * 4,
  width,
  height,
  format: 1,
  bytesPerPixel: 4,
});

function fixture() {
  const compositor = new BurikoBitmapCompositor();
  compositor.defaultFormat = 1;
  const bounds = rectangle(0, 0, 2, 2),
    output = bitmap(3, 3),
    environment = new BurikoDisplayObjectEnvironment(
      compositor,
      new BurikoDisplayDamage(16, {...bounds}),
    );
  environment.displayContext = {bitmap: output, bounds};
  const allocator = new BurikoDistributedAllocator(2),
    text = new BurikoNativeText(),
    surfaces = new BurikoSurfaces(new BurikoNativeFonts(text), compositor, allocator),
    manager = new BurikoDisplayManager(
      environment,
      surfaces,
      new BurikoNativeDisplayState(1920, 1080),
    );
  return {allocator, compositor, environment, manager, output, surfaces, text};
}

test('mosaic backdrop renders native nearest, biased averages and two-source blending', () => {
  const {allocator, manager, output, surfaces, text} = fixture();
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: new BurikoBpMemory(new Uint8Array(0)), diagnostics: {}};
  const errors = {
    files: {text},
    threadFatal() {
      throw new Error('unexpected valid backdrop diagnostic');
    },
  };
  const slot = createGroup90BackdropMosaic(manager, errors)[0];
  assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x90][0x4a]);
  assert.equal(surfaces.allocate(0, 3, 3, 1), 1);
  assert.equal(surfaces.allocate(1, 3, 3, 1), 1);
  const values = [10, 30, 50, 50, 70, 90, 90, 110, 0];
  const gray = (value) => value * 0x010101;
  for (const [index, value] of values.entries()) {
    bitmapWrite32(surfaces.snapshot(0), index * 4, gray(value));
    bitmapWrite32(surfaces.snapshot(1), index * 4, gray(200));
  }
  manager.setBackdropActivation(1, 1);
  const configure = (selector, level, enabled, second = 1) => {
    [0, second, selector, level, enabled].forEach((value) => push32(thread, value));
    assert.equal(slot.execute(context), 0);
    assert.equal(thread.stackIndex, 0);
  };
  configure(0, 1, 0);
  const selected = manager.backdrop;
  assert.ok(selected instanceof BurikoMosaicBackdrop);
  assert.equal(manager.backdropRenderType, 11);
  const renderer = new BurikoDisplayRenderer(
    manager,
    1024,
    new BurikoDistributedProcessing(allocator, 2),
  );
  const pixels = () =>
    Array.from({length: 9}, (_, index) => output.storage.view.getUint32(index * 4, true));
  renderer.drawFull();
  assert.deepEqual(pixels(), [10, 10, 50, 10, 10, 50, 90, 90, 0].map(gray));
  configure(1, 1, 0);
  renderer.drawFull();
  // Partial one-pixel dimensions use reciprocalFFFF and a65536 bias, including alpha.
  assert.deepEqual(
    pixels(),
    [
      0x282828, 0x282828, 0x01464646, 0x282828, 0x282828, 0x01464646, 0x01646464, 0x01646464,
      0x01010101,
    ],
  );
  configure(0, 128, 1);
  renderer.drawFull();
  assert.deepEqual(pixels(), new Array(9).fill(gray(105)));
  configure(1, 128, 1);
  renderer.drawFull();
  // Native normalized row averages30,70,67 produce56; blend with200 gives128.
  assert.deepEqual(pixels(), new Array(9).fill(gray(128)));
  configure(0, 128, 1, 0x7001);
  renderer.drawFull();
  assert.deepEqual(pixels(), new Array(9).fill(gray(132)));
  configure(0, 0, 0);
  renderer.drawFull();
  assert.deepEqual(pixels(), values.map(gray));
  assert.equal(manager.backdrop, selected);
});
