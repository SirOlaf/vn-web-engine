import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {
  bitmapRead8,
  bitmapRead32,
  bitmapWrite32,
} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {applyBurikoBitmapMask} from '../dist/engines/buriko/native/bitmap-alpha-mask.js';
import {createGroup92HaloMask} from '../dist/engines/buriko/native/group-92-halo-mask.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

test('92 halo masks saturate exact neighborhoods and erase through the shared compositor', () => {
  const compositor = new BurikoBitmapCompositor();
  const surfaces = new BurikoSurfaces(
    new BurikoNativeFonts(new BurikoNativeText()),
    compositor,
    new BurikoDistributedAllocator(1),
  );
  assert.equal(surfaces.allocate(1, 3, 1, 2), 1);
  const source = surfaces.snapshot(1);
  [128, 128, 64].forEach((alpha, x) =>
    bitmapWrite32(source, source.offset + x * 4, (alpha << 24) | 0x123456),
  );
  for (const id of [3, 4]) assert.equal(surfaces.allocate(id, 19, 17, 2), 1);
  const rgba = surfaces.snapshot(3),
    output = surfaces.snapshot(4);
  for (let y = 0; y < 17; y++)
    for (let x = 0; x < 19; x++)
      bitmapWrite32(rgba, rgba.offset + y * rgba.stride + x * 4, 0xff123456);
  const [slot] = createGroup92HaloMask(surfaces, {
    threadFatal() {
      assert.fail('ordinary halo succeeds');
    },
  });
  assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x92][0x1b]);
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: new BurikoBpMemory(new Uint8Array(64)), diagnostics: {}};
  // Independent sums for three adjacent source alphas, with saturated overlap.
  const bands = [
    [128, 255, 255, 192, 64],
    [128, 255, 255, 255, 255, 192, 64],
    [128, 255, 255, 255, 255, 255, 255, 192, 64],
  ];
  for (const radius of [1, 2, 3]) {
    [2, 1, radius].forEach((value) => push32(thread, value));
    assert.equal(slot.execute(context), 0);
    assert.equal(thread.stackIndex, 0);
    const mask = surfaces.snapshot(2);
    assert.deepEqual([mask.width, mask.height, mask.format], [19, 17, 3]);
    const expected = Array.from({length: 17}, () => Array(19).fill(0));
    for (let y = 8 - radius; y <= 8 + radius; y++)
      expected[y].splice(8 - radius, bands[radius - 1].length, ...bands[radius - 1]);
    // Mode7 paired lanes use256-alpha, but the third pixel uses255-alpha.
    expected[8][8] = 127;
    expected[8][9] = 127;
    expected[8][10] = radius === 1 ? 143 : 190;
    assert.deepEqual(
      Array.from({length: 17}, (_, y) =>
        Array.from({length: 19}, (_, x) => bitmapRead8(mask, mask.offset + y * mask.stride + x)),
      ),
      expected,
    );
    assert.equal(applyBurikoBitmapMask(output, rgba, mask), 0);
    for (const [x, y, alpha] of [
      [0, 0, 0],
      [8 - radius, 8 - radius, 128],
      [8, 8, 127],
      [10, 8, radius === 1 ? 143 : 190],
    ]) {
      assert.equal(
        bitmapRead32(output, output.offset + y * output.stride + x * 4),
        ((((255 * alpha) >>> 8) << 24) | 0x123456) >>> 0,
      );
    }
  }
});
