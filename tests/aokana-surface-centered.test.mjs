import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {allocateAokanaBitmap} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {
  bitmapRead32,
  bitmapWrite32,
} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {createGroup90SurfaceCentered} from '../dist/engines/buriko/games/aokana/native/group-90-surface-centered.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
const pixels = (bitmap) =>
  Array.from({length: bitmap.width * bitmap.height}, (_, i) =>
    bitmapRead32(
      bitmap,
      bitmap.offset + Math.floor(i / bitmap.width) * bitmap.stride + (i % bitmap.width) * 4,
    ),
  );
const fill = (bitmap, pixel) => {
  for (let y = 0; y < bitmap.height; y++)
    for (let x = 0; x < bitmap.width; x++)
      bitmapWrite32(bitmap, bitmap.offset + y * bitmap.stride + x * 4, pixel(x, y));
};
test('centered surface wrappers crop stretch output and preserve the live rotation angle', () => {
  const compositor = new AokanaBitmapCompositor(),
    text = new AokanaNativeText();
  const surfaces = new AokanaSurfaces(
    new AokanaNativeFonts(text),
    compositor,
    new AokanaDistributedAllocator(2),
  );
  const slots = createGroup90SurfaceCentered(surfaces, {
    files: {text},
    threadFatal() {
      assert.fail('ordinary centered transform');
    },
  });
  assert.deepEqual(
    slots.map((s) => [s.primary, s.secondary]),
    [
      [0x90, 0x1c],
      [0x90, 0x1d],
    ],
  );
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: new AokanaBpMemory(new Uint8Array(0)), diagnostics: {}};
  const call = (secondary, args) => {
    const slot = slots.find((s) => s.secondary === secondary);
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x90][secondary]);
    args.forEach((v) => push32(thread, v));
    assert.equal(slot.execute(context), 0);
    assert.equal(thread.stackIndex, 0);
  };
  const expect = (bitmap, expected) => {
    assert.deepEqual(pixels(bitmap), expected);
    const output = allocateAokanaBitmap(bitmap.width, bitmap.height, 1);
    fill(output, () => 0xabcdef);
    compositor.copy(output, bitmap);
    assert.deepEqual(pixels(output), expected);
  };
  assert.equal(surfaces.allocate(0, 4, 4, 1), 1);
  assert.equal(surfaces.allocate(1, 6, 2, 1), 1);
  const destination = surfaces.snapshot(0),
    source = surfaces.snapshot(1),
    bands = [0x204060, 0x6080a0, 0xa0c0e0],
    sentinel = 0x102030;
  fill(destination, () => sentinel);
  fill(source, (x) => bands[Math.floor(x / 2)]);
  call(0x1c, [0, 1, 1, 2, 2, 1, 2, 0, 2, 2]);
  expect(destination, [
    sentinel,
    sentinel,
    sentinel,
    sentinel,
    sentinel,
    bands[1],
    bands[1],
    sentinel,
    sentinel,
    bands[1],
    bands[1],
    sentinel,
    sentinel,
    sentinel,
    sentinel,
    sentinel,
  ]);
  assert.equal(surfaces.allocate(2, 2, 2, 1), 1);
  assert.equal(surfaces.allocate(3, 6, 6, 1), 1);
  const rotated = surfaces.snapshot(2),
    rows = [0x102030, 0x204060, 0x406080, 0x6080a0, 0x80a0c0, 0xa0c0e0];
  fill(rotated, () => sentinel);
  fill(surfaces.snapshot(3), (_x, y) => rows[y]);
  call(0x1d, [2, 3, 65536, 0]);
  expect(rotated, [rows[2], rows[2], rows[3], rows[3]]);
  call(0x1d, [2, 3, 65536, 180 << 16]);
  expect(rotated, [rows[4], rows[4], rows[3], rows[3]]);
});
