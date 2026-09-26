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
import {createGroup91SurfaceScale} from '../dist/engines/buriko/games/aokana/native/group-91-surface-scale.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
const gray = (value) => (0xff000000 | (value * 0x010101)) >>> 0;
const pixels = (bitmap) =>
  Array.from({length: bitmap.width * bitmap.height}, (_, index) =>
    bitmapRead32(
      bitmap,
      bitmap.offset + Math.floor(index / bitmap.width) * bitmap.stride + (index % bitmap.width) * 4,
    ),
  );
test('surface scale retains floor allocation and rounded nearest/filtered sampling geometry', () => {
  const compositor = new AokanaBitmapCompositor(),
    text = new AokanaNativeText();
  const surfaces = new AokanaSurfaces(
    new AokanaNativeFonts(text),
    compositor,
    new AokanaDistributedAllocator(2),
  );
  const [slot] = createGroup91SurfaceScale(surfaces, {
    files: {text},
    threadFatal() {
      assert.fail('ordinary surface scaling');
    },
  });
  assert.equal(slot.primary, 0x91);
  assert.equal(slot.secondary, 0x1c);
  assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x91][0x1c]);
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: new AokanaBpMemory(new Uint8Array(0)), diagnostics: {}};
  assert.equal(surfaces.allocate(0, 3, 2, 2), 1);
  const source = surfaces.snapshot(0);
  [64, 128, 192, 96, 160, 224].forEach((value, index) =>
    bitmapWrite32(
      source,
      source.offset + Math.floor(index / 3) * source.stride + (index % 3) * 4,
      gray(value),
    ),
  );
  const expected = [
    [64, 64, 128, 128, 96, 96, 160, 160],
    [64, 89, 115, 140, 80, 105, 131, 156],
  ];
  for (let sampling = 0; sampling < 2; sampling++) {
    [sampling + 1, 0, 0x18000, 0x10000, sampling].forEach((value) => push32(thread, value));
    assert.equal(slot.execute(context), 0);
    assert.equal(thread.stackIndex, 0);
    const scaled = surfaces.snapshot(sampling + 1);
    assert.deepEqual([scaled.width, scaled.height, scaled.format], [4, 2, 2]);
    const colors = expected[sampling].map(gray);
    assert.deepEqual(pixels(scaled), colors);
    const output = allocateAokanaBitmap(4, 2, 2);
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 4; x++)
        bitmapWrite32(output, output.offset + y * output.stride + x * 4, 0x11223344);
    compositor.copy(output, scaled);
    assert.deepEqual(pixels(output), colors);
  }
});
