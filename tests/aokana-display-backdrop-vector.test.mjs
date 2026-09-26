import {bitmapWrite32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {BurikoVectorBackdrop} from '../dist/engines/buriko/native/display-backdrop-vector.js';
import {createGroup90BackdropVector} from '../dist/engines/buriko/native/group-90-backdrop-vector.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, push32, pop32} from '../dist/engines/buriko/bp/state.js';
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
  const bounds = rectangle(0, 0, 1, 1),
    output = bitmap(2, 2),
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

test('vector backdrop shares the real map renderer and lifecycle/query wrappers', () => {
  const {allocator, environment, manager, output, surfaces, text} = fixture();
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
  const slots = createGroup90BackdropVector(manager, errors);
  for (const slot of slots)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x90][slot.secondary]);
  const call = (secondary, ...args) => {
    args.forEach((value) => push32(thread, value));
    assert.equal(slots.find((slot) => slot.secondary === secondary).execute(context), 0);
  };
  const colors = [0x102030, 0x405060, 0x708090, 0xa0b0c0];
  assert.equal(surfaces.allocate(0, 2, 2, 1), 1);
  const source = surfaces.snapshot(0);
  colors.forEach((color, index) =>
    bitmapWrite32(
      source,
      source.offset + Math.floor(index / 2) * source.stride + (index % 2) * 4,
      color,
    ),
  );
  for (const index of [1, 2]) assert.equal(surfaces.allocate(index, 2, 2, 4), 1);
  const primary = surfaces.snapshot(1),
    secondary = surfaces.snapshot(2);
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 2; x++) {
      bitmapWrite32(primary, primary.offset + y * primary.stride + x * 4, x === 0 ? 16 : 0xfff0);
      bitmapWrite32(
        secondary,
        secondary.offset + y * secondary.stride + x * 4,
        (y === 0 ? 16 : 0xfff0) << 16,
      );
    }
  call(0x4c, 1, 1);
  call(0x45, 0, 1, -1, 0, 0);
  assert.equal(thread.stackIndex, 0);
  const selected = manager.backdrop;
  assert.ok(selected instanceof BurikoVectorBackdrop);
  call(0x4d);
  assert.equal(pop32(thread), 6);
  const renderer = new BurikoDisplayRenderer(
    manager,
    1024,
    new BurikoDistributedProcessing(allocator, 2),
  );
  assert.equal(renderer.canUseStrips(), 0);
  const expectPixels = (values) => {
    renderer.drawFull();
    assert.deepEqual(
      Array.from({length: 4}, (_, index) => output.storage.view.getUint32(index * 4, true)),
      values,
    );
  };
  expectPixels(colors);
  call(0x45, 0, 1, -1, 256, 0);
  assert.equal(manager.backdrop, selected);
  expectPixels([colors[1], colors[0], colors[3], colors[2]]);
  call(0x45, 0, 1, 2, 256, 0);
  expectPixels([colors[2], colors[3], colors[0], colors[1]]);
  call(0x45, 0, 1, 2, 0, 0);
  expectPixels([colors[1], colors[0], colors[3], colors[2]]);
  call(0x45, 0, 1, 2, 128, 1);
  expectPixels(new Array(4).fill(0x586878)); // All four vectors meet at the image center.
  call(0x4c, 1, 0);
  assert.equal(environment.damage.fullRedraw, 1);
  expectPixels([0, 0, 0, 0]);
  call(0x4c, 1, 1);
  expectPixels(new Array(4).fill(0x586878));
  assert.equal(thread.stackIndex, 0);
});
