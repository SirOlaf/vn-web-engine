import {bitmapWrite32, bitmapWrite8} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {createGroup91SurfaceColorMaskCopy} from '../dist/engines/buriko/native/group-91-surface-color-mask-copy.js';
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
  const bounds = rectangle(0, 0, 3, 1),
    output = bitmap(4, 2),
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

test('surface recolor, color effect, offset mask and copy feed a real Sprite', () => {
  const {allocator, compositor, manager, surfaces, output, text} = fixture();
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: new BurikoBpMemory(new Uint8Array(8)), diagnostics: {}};
  const slots = createGroup91SurfaceColorMaskCopy(surfaces, {
    files: {text},
    threadFatal() {
      assert.fail('ordinary surface operation');
    },
  });
  assert.deepEqual(
    slots.map((slot) => [slot.primary, slot.secondary]),
    [
      [0x91, 0x1a],
      [0x91, 0x1d],
      [0x91, 0x1e],
      [0x91, 0x1f],
    ],
  );
  for (const slot of slots)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x91][slot.secondary]);
  const call = (secondary, args) => {
    args.forEach((value) => push32(thread, value));
    assert.equal(slots.find((slot) => slot.secondary === secondary).execute(context), 0);
    assert.equal(thread.stackIndex, 0);
  };
  for (const index of [0, 1, 2]) assert.equal(surfaces.allocate(index, 4, 2, 2), 1);
  assert.equal(surfaces.allocate(4, 4, 2, 3), 1);
  const source = surfaces.snapshot(0),
    mask = surfaces.snapshot(4);
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 4; x++) {
      bitmapWrite32(
        source,
        source.offset + y * source.stride + x * 4,
        ([192, 128, 255, 64][x] << 24) | 0xabcdef,
      );
      bitmapWrite8(mask, mask.offset + y * mask.stride + x, [255, 128, 64, 0][x]);
    }
  const processing = new BurikoDistributedProcessing(allocator, 2);
  compositor.processing = processing;
  call(0x1a, [1, 0, 0x203040]);
  call(0x1d, [2, 1, 4, 0x202020, 128]);
  call(0x1e, [2, 4, 1, 0]);
  assert.equal(surfaces.setMetadata(2, 13, -4), 1);
  call(0x1f, [3, 2]);
  const copied = surfaces.snapshot(3),
    record = surfaces.record(3);
  assert.deepEqual([record.metadataX, record.metadataY], [13, -4]);
  const pixelRows = (image) =>
    Array.from({length: 2}, (_, y) =>
      Array.from({length: 4}, (_, x) =>
        image.storage.view.getUint32(image.offset + y * image.stride + x * 4, true),
      ),
    );
  const copiedRow = [0x60304050, 0x20304050, 0x00304050, 0x40304050];
  assert.deepEqual(pixelRows(copied), [copiedRow, copiedRow]);
  const sprite = manager.createSprite();
  assert.equal(manager.initializeSimpleSprite(sprite, 0, 0, 3, 0, 0, 2), 0);
  manager.find('sprite', sprite).setActivation(1);
  manager.setBackdropActivation(1, 1);
  const renderer = new BurikoDisplayRenderer(manager, 1024, processing);
  renderer.drawFull();
  const renderedRow = [0x12181e, 0x06080a, 0, 0x0c1014];
  assert.deepEqual(pixelRows(output), [renderedRow, renderedRow]);
});
