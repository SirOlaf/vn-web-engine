import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {createGroup92SurfacePixels} from '../dist/engines/buriko/native/group-92-surface-pixels.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

const pointer = (bytes) => ({bytes, offset: 0});
const dwords = (values) => {
  const bytes = new Uint8Array(values.length * 4),
    view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value, true));
  return pointer(bytes);
};

test('surface metadata and color opcodes feed actual pixel queries and surface copying', () => {
  const compositor = new BurikoBitmapCompositor();
  const surfaces = new BurikoSurfaces(
    new BurikoNativeFonts(new BurikoNativeText()),
    compositor,
    new BurikoDistributedAllocator(1),
  );
  const memory = new BurikoBpMemory(new Uint8Array(128));
  const view = new DataView(memory.globalMemory.buffer);
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 32,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory, diagnostics: {}};
  const definitions = createGroup92SurfacePixels(surfaces);
  const slots = new Map(definitions.map((slot) => [slot.secondary, slot]));
  for (const slot of definitions)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x92][slot.secondary]);
  const run = (secondary, values, expected) => {
    for (const value of values) push32(thread, value);
    assert.equal(slots.get(secondary).execute(context), 0);
    assert.equal(pop32(thread), expected);
    assert.equal(thread.stackIndex, 0);
  };
  const pixels = (surface) =>
    [0, 1, 2].map((x) => {
      run(0x17, [32, surface, x, 0], 0);
      return view.getUint32(32, true);
    });

  assert.equal(
    surfaces.importRaw(1, 3, 1, 2, dwords([0x40224466, 0x80224466, 0xc0112233]), [12, -7]),
    1,
  );
  run(0x16, [8, 1], 1);
  assert.deepEqual([view.getInt32(8, true), view.getInt32(12, true)], [12, -7]);
  run(0x12, [1, -3, 19], 1);
  run(0x16, [8, 1], 1);
  assert.deepEqual([view.getInt32(8, true), view.getInt32(12, true)], [-3, 19]);

  // A zero-alpha search replaces RGB while retaining each distinct source alpha.
  run(0x13, [1, 0x00224466, 0xeeaabbcc], 0);
  assert.deepEqual(pixels(1), [0x40aabbcc, 0x80aabbcc, 0xc0112233]);
  // A nonzero-alpha search compares the complete DWORD and replaces it completely.
  run(0x13, [1, 0x80aabbcc, 0x60402010], 0);
  assert.deepEqual(pixels(1), [0x40aabbcc, 0x60402010, 0xc0112233]);
  assert.equal(surfaces.importRaw(2, 3, 1, 2, dwords([0, 0, 0])), 1);
  assert.equal(surfaces.drawSurface(2, 0, 0, 1, 0x80, 0), 0);
  assert.deepEqual(pixels(2), [0x40aabbcc, 0x60402010, 0xc0112233]);

  assert.equal(
    surfaces.importRaw(3, 2, 1, 1, pointer(Uint8Array.of(0x66, 0x44, 0x22, 0x33, 0x22, 0x11))),
    1,
  );
  run(0x13, [3, 0xaa224466, 0xddabcdef], 0);
  run(0x17, [32, 3, 0, 0], 0);
  assert.equal(view.getUint32(32, true), 0x00abcdef);
  run(0x17, [32, 3, 1, 0], 0);
  assert.equal(view.getUint32(32, true), 0x00112233);

  assert.equal(surfaces.importRaw(4, 1, 1, 0, pointer(Uint8Array.of(0x34, 0x12))), 1);
  view.setUint32(32, 0xaabbccdd, true);
  run(0x17, [32, 4, 0, 0], 0);
  assert.equal(view.getUint32(32, true), 0x00001234);
});
