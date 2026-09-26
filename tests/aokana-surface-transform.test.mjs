import {bitmapWrite32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {createGroup91SurfaceTransform} from '../dist/engines/buriko/native/group-91-surface-transform.js';
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
  const bounds = rectangle(0, 0, 2, 1),
    output = bitmap(3, 2),
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

test('91:18/19 rotate and blend initialized surfaces consumed by a real Sprite', () => {
  const {allocator, compositor, manager, surfaces, output, text} = fixture();
  const thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    context = {thread, memory: new BurikoBpMemory(new Uint8Array(8)), diagnostics: {}},
    slots = createGroup91SurfaceTransform(surfaces, {
      files: {text},
      threadFatal() {
        assert.fail('ordinary surface transform');
      },
    });
  for (const slot of slots)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x91][slot.secondary]);
  const call = (secondary, args) => {
    args.forEach((value) => push32(thread, value));
    assert.equal(slots.find((slot) => slot.secondary === secondary).execute(context), 0);
    assert.equal(thread.stackIndex, 0);
  };
  const gray = (value) => value * 0x010101;
  assert.equal(surfaces.allocate(0, 2, 3, 1), 1);
  for (const index of [1, 2]) assert.equal(surfaces.allocate(index, 3, 2, 1), 1);
  const source = surfaces.snapshot(0);
  for (let i = 0; i < 6; i++) bitmapWrite32(source, source.offset + i * 4, gray((i + 1) * 16));
  for (const index of [1, 2]) {
    const image = surfaces.snapshot(index);
    for (let i = 0; i < 6; i++)
      bitmapWrite32(image, image.offset + i * 4, gray(index === 2 ? 128 : 0));
  }
  const processing = new BurikoDistributedProcessing(allocator, 2);
  compositor.processing = processing;
  const pixels = (image) =>
    Array.from({length: image.height}, (_, y) =>
      Array.from({length: image.width}, (_, x) =>
        image.storage.view.getUint32(image.offset + y * image.stride + x * 4, true),
      ),
    ).flat();
  try {
    call(0x19, [1, 0, 0, 0, 65536, 0, 90 * 65536, 65536, 65536, 0, 0]);
    assert.deepEqual(pixels(surfaces.snapshot(1)), [32, 64, 96, 16, 48, 80].map(gray));
    call(0x18, [2, 0, 0, 1, 0, 0, 0, 65536, 65536, 128, 0]);
    const expected = [80, 96, 112, 72, 88, 104].map(gray);
    assert.deepEqual(pixels(surfaces.snapshot(2)), expected);
    const sprite = manager.createSprite();
    assert.equal(manager.initializeSimpleSprite(sprite, 0, 0, 2, 0, 0, 2), 0);
    manager.find('sprite', sprite).setActivation(1);
    manager.setBackdropActivation(1, 1);
    new BurikoDisplayRenderer(manager, 1024, processing).drawFull();
    assert.deepEqual(pixels(output), expected);
  } finally {
    processing.dispose();
  }
});
