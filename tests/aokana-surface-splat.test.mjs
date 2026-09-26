import {bitmapWrite32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {createGroup91SurfaceSplat} from '../dist/engines/buriko/native/group-91-surface-splat.js';
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
  const bounds = rectangle(0, 0, 3, 3),
    output = bitmap(4, 4),
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

test('91:1B half-scale accumulation and attenuation feed an actual Sprite', () => {
  const {allocator, compositor, manager, surfaces, output, text} = fixture(),
    thread = new BurikoBpThread({id: 1, operandCapacity: 8, moduleCapacity: 0, frameCapacity: 0}),
    context = {thread, memory: new BurikoBpMemory(new Uint8Array(8)), diagnostics: {}},
    [slot] = createGroup91SurfaceSplat(surfaces, {
      files: {text},
      threadFatal() {
        assert.fail('ordinary initialized accumulation');
      },
    });
  assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x91][0x1b]);
  for (const index of [0, 1]) {
    assert.equal(surfaces.allocate(index, 4, 4, 1), 1);
    const image = surfaces.snapshot(index);
    for (let i = 0; i < 16; i++)
      bitmapWrite32(image, image.offset + i * 4, index === 0 ? 0x202020 : 0x808080);
  }
  for (const value of [1, 0, 32768, 32768, 128]) push32(thread, value);
  assert.equal(slot.execute(context), 0);
  assert.equal(thread.stackIndex, 0);
  const expected = [4, 16, 12, 0, 16, 64, 48, 0, 12, 48, 36, 0, 0, 0, 0, 0].map(
      (v) => v * 0x010101,
    ),
    pixels = (image) =>
      Array.from({length: 4}, (_, y) =>
        Array.from({length: 4}, (_, x) =>
          image.storage.view.getUint32(image.offset + y * image.stride + x * 4, true),
        ),
      ).flat();
  assert.deepEqual(pixels(surfaces.snapshot(1)), expected);
  assert.deepEqual(pixels(surfaces.snapshot(0)), Array(16).fill(0x202020));
  const processing = new BurikoDistributedProcessing(allocator, 2);
  compositor.processing = processing;
  try {
    const sprite = manager.createSprite();
    assert.equal(manager.initializeSimpleSprite(sprite, 0, 0, 1, 0, 0, 2), 0);
    manager.find('sprite', sprite).setActivation(1);
    manager.setBackdropActivation(1, 1);
    new BurikoDisplayRenderer(manager, 1024, processing).drawFull();
    assert.deepEqual(pixels(output), expected);
  } finally {
    processing.dispose();
  }
});
