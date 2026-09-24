import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {
  allocateAokanaBitmap,
  aokanaBitmapRectangle,
} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {
  bitmapRead8,
  bitmapRead32,
  bitmapWrite32,
} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {applyAokanaBitmapMask} from '../dist/engines/buriko/games/aokana/native/bitmap-alpha-mask.js';
import {createGroup92AlphaExtraction} from '../dist/engines/buriko/games/aokana/native/group-92-alpha-extraction.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

test('92 alpha extraction clips into real display geometry and feeds actual mask rendering', () => {
  const compositor = new AokanaBitmapCompositor();
  const surfaces = new AokanaSurfaces(
    new AokanaNativeFonts(new AokanaNativeText()),
    compositor,
    new AokanaDistributedAllocator(1),
  );
  const environment = new AokanaDisplayObjectEnvironment(
    compositor,
    new AokanaDisplayDamage(16, {left: 0, top: 0, right: 4, bottom: 2}),
  );
  const display = allocateAokanaBitmap(5, 3, 2);
  environment.displayContext = {bitmap: display, bounds: aokanaBitmapRectangle(display)};
  for (const id of [1, 2]) assert.equal(surfaces.allocate(id, 3, 1, 2), 1);
  for (const [id, alphas] of [
    [1, [0, 64, 255]],
    [2, [128, 192, 1]],
  ]) {
    const bitmap = surfaces.snapshot(id);
    alphas.forEach((alpha, x) =>
      bitmapWrite32(bitmap, bitmap.offset + x * 4, (alpha << 24) | 0x123456),
    );
  }
  for (const id of [4, 5]) assert.equal(surfaces.allocate(id, 5, 3, 2), 1);
  const source = surfaces.snapshot(4),
    destination = surfaces.snapshot(5);
  for (let y = 0; y < 3; y++)
    for (let x = 0; x < 5; x++)
      bitmapWrite32(source, source.offset + y * source.stride + x * 4, 0xff123456);
  const [slot] = createGroup92AlphaExtraction(surfaces, environment, {
    threadFatal() {
      assert.fail('ordinary alpha extraction succeeds');
    },
  });
  assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x92][0x1a]);
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 32,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: new AokanaBpMemory(new Uint8Array(64)), diagnostics: {}};
  const run = (x, y, second, level, expected) => {
    [3, x, y, 1, second, level].forEach((value) => push32(thread, value));
    assert.equal(slot.execute(context), 0);
    assert.equal(thread.stackIndex, 0);
    const mask = surfaces.snapshot(3);
    assert.deepEqual([mask.width, mask.height, mask.format], [5, 3, 3]);
    assert.deepEqual(
      Array.from({length: 3}, (_, row) =>
        Array.from({length: 5}, (_, column) =>
          bitmapRead8(mask, mask.offset + row * mask.stride + column),
        ),
      ),
      expected,
    );
    assert.equal(applyAokanaBitmapMask(destination, source, mask), 0);
    assert.deepEqual(
      Array.from({length: 3}, (_, row) =>
        Array.from({length: 5}, (_, column) =>
          bitmapRead32(destination, destination.offset + row * destination.stride + column * 4),
        ),
      ),
      expected.map((row) => row.map((alpha) => ((((255 * alpha) >>> 8) << 24) | 0x123456) >>> 0)),
    );
  };
  // Midpoint alpha:0→128=64,64→192=128,255→1=128. Exterior strips clear.
  run(1, 1, 2, 128, [
    [0, 0, 0, 0, 0],
    [0, 64, 128, 128, 0],
    [0, 0, 0, 0, 0],
  ]);
  // Clipped copy initially publishes64/255, then literal native right strip starts at2-1=1.
  run(-1, 0, 0xffffffff, 0, [
    [64, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0],
  ]);
});
