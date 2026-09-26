import {bitmapWrite32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {AokanaMosaicBackdrop} from '../dist/engines/buriko/games/aokana/native/display-backdrop-mosaic.js';
import {createGroup90BackdropMosaic} from '../dist/engines/buriko/games/aokana/native/group-90-backdrop-mosaic.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaBitmapStorage} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaDisplayRenderer} from '../dist/engines/buriko/games/aokana/native/display-renderer.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

const rectangle = (left, top, right, bottom) => ({left, top, right, bottom});
const bitmap = (width, height, values = []) => ({
  storage: new AokanaBitmapStorage(
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
  const compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 1;
  const bounds = rectangle(0, 0, 2, 2),
    output = bitmap(3, 3),
    environment = new AokanaDisplayObjectEnvironment(
      compositor,
      new AokanaDisplayDamage(16, {...bounds}),
    );
  environment.displayContext = {bitmap: output, bounds};
  const allocator = new AokanaDistributedAllocator(2),
    text = new AokanaNativeText(),
    surfaces = new AokanaSurfaces(new AokanaNativeFonts(text), compositor, allocator),
    manager = new AokanaDisplayManager(
      environment,
      surfaces,
      new AokanaNativeDisplayState(1920, 1080),
    );
  return {allocator, compositor, environment, manager, output, surfaces, text};
}

test('mosaic backdrop renders native nearest, biased averages and two-source blending', () => {
  const {allocator, manager, output, surfaces, text} = fixture();
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: new AokanaBpMemory(new Uint8Array(0)), diagnostics: {}};
  const errors = {
    files: {text},
    threadFatal() {
      throw new Error('unexpected valid backdrop diagnostic');
    },
  };
  const slot = createGroup90BackdropMosaic(manager, errors)[0];
  assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x90][0x4a]);
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
  assert.ok(selected instanceof AokanaMosaicBackdrop);
  assert.equal(manager.backdropRenderType, 11);
  const renderer = new AokanaDisplayRenderer(
    manager,
    1024,
    new AokanaDistributedProcessing(allocator, 2),
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
