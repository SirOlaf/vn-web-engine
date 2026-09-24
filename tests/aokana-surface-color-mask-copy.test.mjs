import {
  bitmapWrite32,
  bitmapWrite8,
} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {createGroup91SurfaceColorMaskCopy} from '../dist/engines/buriko/games/aokana/native/group-91-surface-color-mask-copy.js';
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
  const bounds = rectangle(0, 0, 3, 1),
    output = bitmap(4, 2),
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

test('surface recolor, color effect, offset mask and copy feed a real Sprite', () => {
  const {allocator, compositor, manager, surfaces, output, text} = fixture();
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: new AokanaBpMemory(new Uint8Array(8)), diagnostics: {}};
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
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x91][slot.secondary]);
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
  const processing = new AokanaDistributedProcessing(allocator, 2);
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
  const renderer = new AokanaDisplayRenderer(manager, 1024, processing);
  renderer.drawFull();
  const renderedRow = [0x12181e, 0x06080a, 0, 0x0c1014];
  assert.deepEqual(pixelRows(output), [renderedRow, renderedRow]);
});
