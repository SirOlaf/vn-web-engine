import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {allocateBurikoBitmap} from '../dist/engines/buriko/native/bitmap.js';
import {bitmapRead32, bitmapWrite32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {applyBurikoEffectorVectorMap} from '../dist/engines/buriko/native/bitmap-display-filters.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {createGroup91AngularDisplacement} from '../dist/engines/buriko/native/group-91-angular-displacement.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

test('angular projection and bend feed actual nearest map sampling', () => {
  const compositor = new BurikoBitmapCompositor(),
    text = new BurikoNativeText();
  const surfaces = new BurikoSurfaces(
    new BurikoNativeFonts(text),
    compositor,
    new BurikoDistributedAllocator(2),
  );
  const slots = createGroup91AngularDisplacement(surfaces, {
    files: {text},
    threadFatal() {
      assert.fail('ordinary displacement generator');
    },
  });
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: new BurikoBpMemory(new Uint8Array(0)), diagnostics: {}};
  assert.deepEqual(
    slots.map((s) => s.secondary),
    [0x13, 0x14],
  );
  const cases = [
    // Angular45/63.435/26.565/45degrees: truncation produces these Q4 coordinates.
    {
      slot: 0x13,
      w: 2,
      h: 2,
      sourceW: 2,
      sourceH: 6,
      args: [-1, -1, 0, 2],
      words: [
        [10, 45],
        [-6, 71],
        [9, 55],
        [-6, 74],
      ],
      indices: [4, 8, 8, 10],
    },
    // Ratio1/32 exercises compensated small-ratio atan2;32*sqrt1025 truncates1024.
    {
      slot: 0x13,
      w: 1,
      h: 1,
      sourceW: 1,
      sourceH: 65,
      args: [-1, -32, 0, 1],
      words: [[0, 1024]],
      indices: [64],
    },
    // Bend products remain comfortably inside intervals(-2,-1) and(-6,-5).
    {
      slot: 0x14,
      w: 2,
      h: 2,
      sourceW: 2,
      sourceH: 2,
      args: [-1, -1, 60 * 65536, 4],
      words: [
        [-1, -1],
        [-5, -1],
        [-1, -5],
        [-5, -5],
      ],
      indices: [-1, -1, -1, 0],
    },
  ];
  for (let i = 0; i < cases.length; i++) {
    const entry = cases[i],
      slot = slots.find((s) => s.secondary === entry.slot);
    const source = allocateBurikoBitmap(entry.sourceW, entry.sourceH, 1);
    const colors = Array.from(
      {length: entry.sourceW * entry.sourceH},
      (_, index) => 0x102030 + index * 0x010101,
    );
    colors.forEach((color, index) =>
      bitmapWrite32(
        source,
        source.offset +
          Math.floor(index / entry.sourceW) * source.stride +
          (index % entry.sourceW) * 4,
        color,
      ),
    );
    assert.equal(slot.primary, 0x91);
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x91][entry.slot]);
    assert.equal(surfaces.allocate(i, entry.w, entry.h, 4), 1);
    [i, ...entry.args].forEach((value) => push32(thread, value));
    assert.equal(slot.execute(context), 0);
    assert.equal(thread.stackIndex, 0);
    const map = surfaces.snapshot(i),
      output = allocateBurikoBitmap(entry.w, entry.h, 1);
    assert.deepEqual(
      Array.from({length: entry.w * entry.h}, (_, index) => {
        const at = map.offset + Math.floor(index / entry.w) * map.stride + (index % entry.w) * 4;
        const pair = bitmapRead32(map, at);
        return [(pair << 16) >> 16, pair >> 16];
      }),
      entry.words,
    );
    assert.equal(applyBurikoEffectorVectorMap(compositor, output, source, map, null, 256, 0), 0);
    assert.deepEqual(
      Array.from({length: entry.w * entry.h}, (_, index) =>
        bitmapRead32(
          output,
          output.offset + Math.floor(index / entry.w) * output.stride + (index % entry.w) * 4,
        ),
      ),
      entry.indices.map((index) => (index < 0 ? 0 : colors[index])),
    );
  }
});
