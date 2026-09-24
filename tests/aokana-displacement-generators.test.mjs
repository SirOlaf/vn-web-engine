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
import {applyAokanaEffectorVectorMap} from '../dist/engines/buriko/games/aokana/native/bitmap-display-filters.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {createGroup91DisplacementGenerators} from '../dist/engines/buriko/games/aokana/native/group-91-displacement-generators.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

test('four displacement generators feed actual nearest map sampling', () => {
  const compositor = new AokanaBitmapCompositor(),
    text = new AokanaNativeText();
  const surfaces = new AokanaSurfaces(
    new AokanaNativeFonts(text),
    compositor,
    new AokanaDistributedAllocator(2),
  );
  const slots = createGroup91DisplacementGenerators(surfaces, {
    files: {text},
    threadFatal() {
      assert.fail('ordinary displacement generator');
    },
  });
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: new AokanaBpMemory(new Uint8Array(0)), diagnostics: {}};
  assert.deepEqual(
    slots.map((s) => s.secondary),
    [0x12, 0x15, 0x16, 0x17],
  );
  const source = allocateAokanaBitmap(3, 3, 1);
  const colors = [
    0x102030, 0x203040, 0x304050, 0x405060, 0x506070, 0x607080, 0x708090, 0x8090a0, 0x90a0b0,
  ];
  colors.forEach((color, i) =>
    bitmapWrite32(source, source.offset + Math.floor(i / 3) * source.stride + (i % 3) * 4, color),
  );
  const cases = [
    // 2048 squared /131072 gives32 in each axis.
    {slot: 0x12, w: 1, h: 1, args: [0, 0, 2, 0, 1024], words: [[32, 32]], pixels: [colors[8]]},
    // Integer-cycle phase reaches verified exponent34; adjacent consumed heights truncate0.
    {
      slot: 0x12,
      w: 1,
      h: 1,
      args: [0, 0, 1, 0xffffffff, 1024],
      words: [[0, 0]],
      pixels: [colors[0]],
    },
    // Peak4194304 squared /2147483648 gives8192; ordinary exterior samples are black.
    {
      slot: 0x15,
      w: 2,
      h: 2,
      args: [1, 1, 1, 1],
      words: [
        [0, 0],
        [0, 8192],
        [8192, 0],
        [-8192, -8192],
      ],
      pixels: [colors[0], 0, 0, 0],
    },
    {
      slot: 0x16,
      w: 2,
      h: 2,
      args: [4, 0, 1, 4, 0, 1],
      words: [
        [0, 0],
        [0, 16],
        [16, 0],
        [16, 16],
      ],
      pixels: [colors[0], colors[4], colors[4], colors[8]],
    },
    {
      slot: 0x17,
      w: 2,
      h: 1,
      args: [1, 0, 0, 0, 0],
      words: [
        [16, 0],
        [16, 0],
      ],
      pixels: [colors[1], colors[2]],
    },
  ];
  for (let i = 0; i < cases.length; i++) {
    const entry = cases[i],
      slot = slots.find((s) => s.secondary === entry.slot);
    assert.equal(slot.primary, 0x91);
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x91][entry.slot]);
    assert.equal(surfaces.allocate(i, entry.w, entry.h, 4), 1);
    [i, ...entry.args].forEach((value) => push32(thread, value));
    assert.equal(slot.execute(context), 0);
    assert.equal(thread.stackIndex, 0);
    const map = surfaces.snapshot(i),
      output = allocateAokanaBitmap(entry.w, entry.h, 1);
    assert.deepEqual(
      Array.from({length: entry.w * entry.h}, (_, index) => {
        const at = map.offset + Math.floor(index / entry.w) * map.stride + (index % entry.w) * 4;
        const pair = bitmapRead32(map, at);
        return [(pair << 16) >> 16, pair >> 16];
      }),
      entry.words,
    );
    assert.equal(applyAokanaEffectorVectorMap(compositor, output, source, map, null, 256, 0), 0);
    assert.deepEqual(
      Array.from({length: entry.w * entry.h}, (_, index) =>
        bitmapRead32(
          output,
          output.offset + Math.floor(index / entry.w) * output.stride + (index % entry.w) * 4,
        ),
      ),
      entry.pixels,
    );
  }
});
