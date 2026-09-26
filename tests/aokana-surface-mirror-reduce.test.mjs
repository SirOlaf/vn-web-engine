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
import {createGroup90SurfaceMirrorReduce} from '../dist/engines/buriko/games/aokana/native/group-90-surface-mirror-reduce.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
const gray = (value) => (0xff000000 | (value * 0x010101)) >>> 0;
const pixels = (bitmap) =>
  Array.from({length: bitmap.width * bitmap.height}, (_, index) =>
    bitmapRead32(
      bitmap,
      bitmap.offset + Math.floor(index / bitmap.width) * bitmap.stride + (index % bitmap.width) * 4,
    ),
  );
test('surface mirror directions and odd half reduction feed actual bitmap copying', () => {
  const compositor = new AokanaBitmapCompositor(),
    text = new AokanaNativeText();
  const surfaces = new AokanaSurfaces(
    new AokanaNativeFonts(text),
    compositor,
    new AokanaDistributedAllocator(2),
  );
  const slots = createGroup90SurfaceMirrorReduce(surfaces, {
    files: {text},
    threadFatal() {
      assert.fail('ordinary mirror and reduction');
    },
  });
  assert.deepEqual(
    slots.map((slot) => [slot.primary, slot.secondary]),
    [
      [0x90, 0xc2],
      [0x90, 0xc3],
    ],
  );
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: new AokanaBpMemory(new Uint8Array(0)), diagnostics: {}};
  assert.equal(surfaces.allocate(0, 3, 3, 2), 1);
  const source = surfaces.snapshot(0);
  [0, 0, 20, 1, 3, 21, 40, 43, 99].forEach((value, index) =>
    bitmapWrite32(
      source,
      source.offset + Math.floor(index / 3) * source.stride + (index % 3) * 4,
      gray(value),
    ),
  );
  const cases = [
    {slot: 0xc2, args: [1, 0, 0], width: 3, height: 3, expected: [20, 0, 0, 21, 3, 1, 99, 43, 40]},
    {slot: 0xc2, args: [2, 0, 1], width: 3, height: 3, expected: [40, 43, 99, 1, 3, 21, 0, 0, 20]},
    // Vertical ceil averages1/2 followed by horizontal ceil gives2; odd edges21/42/99.
    {slot: 0xc3, args: [3, 0], width: 2, height: 2, expected: [2, 21, 42, 99]},
  ];
  for (const entry of cases) {
    const slot = slots.find((slot) => slot.secondary === entry.slot);
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x90][entry.slot]);
    entry.args.forEach((value) => push32(thread, value));
    assert.equal(slot.execute(context), 0);
    assert.equal(thread.stackIndex, 0);
    const result = surfaces.snapshot(entry.args[0]);
    assert.deepEqual([result.width, result.height, result.format], [entry.width, entry.height, 2]);
    const expected = entry.expected.map(gray);
    assert.deepEqual(pixels(result), expected);
    const output = allocateAokanaBitmap(entry.width, entry.height, 2);
    compositor.copy(output, result);
    assert.deepEqual(pixels(output), expected);
  }
});
