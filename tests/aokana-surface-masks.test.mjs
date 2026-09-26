import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {applyBurikoBitmapMask} from '../dist/engines/buriko/native/bitmap-alpha-mask.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoEngineErrors} from '../dist/engines/buriko/native/engine-errors.js';
import {BurikoBpDiagnostics} from '../dist/engines/buriko/native/diagnostics.js';
import {createGroup92SurfaceMasks} from '../dist/engines/buriko/native/group-92-surface-masks.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

const pointer = (bytes) => ({bytes, offset: 0});
const dwords = (values) => {
  const bytes = new Uint8Array(values.length * 4),
    view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value, true));
  return pointer(bytes);
};

test('surface mask opcodes convert RGB and RGBA, invert and feed actual alpha-mask rendering', () => {
  const text = new BurikoNativeText(),
    compositor = new BurikoBitmapCompositor();
  const surfaces = new BurikoSurfaces(
    new BurikoNativeFonts(text),
    compositor,
    new BurikoDistributedAllocator(1),
  );
  const errors = new BurikoEngineErrors(
    {text},
    {show: () => assert.fail('Unexpected ordinary mask error')},
    Uint8Array.of(0),
    Uint8Array.of(0),
  );
  const memory = new BurikoBpMemory(new Uint8Array(32));
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const diagnostics = new BurikoBpDiagnostics(() => assert.fail('Unexpected diagnostic'));
  const context = {thread, memory, diagnostics};
  const definitions = createGroup92SurfaceMasks(surfaces, errors);
  const slots = new Map(definitions.map((slot) => [slot.secondary, slot]));
  for (const slot of definitions)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x92][slot.secondary]);
  const run = (secondary, values) => {
    for (const value of values) push32(thread, value);
    assert.equal(slots.get(secondary).execute(context), 0);
    if (secondary === 0x19) assert.equal(pop32(thread), 1);
    assert.equal(thread.stackIndex, 0);
  };
  const read = (surface, count) =>
    Array.from({length: count}, (_, x) => {
      const output = {bytes: memory.globalMemory, offset: 8};
      assert.equal(surfaces.readPixel(output, surface, x, 0), 0);
      return new DataView(memory.globalMemory.buffer).getUint32(8, true);
    });

  // BGR input: white, red, green, blue. Weights are77R+151G+28B, divided256.
  assert.equal(
    surfaces.importRaw(
      1,
      4,
      1,
      1,
      pointer(Uint8Array.of(255, 255, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0)),
    ),
    1,
  );
  run(0x18, [2, 1]);
  assert.deepEqual(read(2, 4), [255, 76, 150, 27]);
  assert.equal(surfaces.importRaw(3, 2, 1, 2, dwords([0x80ffffff, 0xffff0000])), 1);
  run(0x18, [4, 3]);
  // RGBA multiplies by alpha before division65536: white128→127, red255→76.
  assert.deepEqual(read(4, 2), [127, 76]);
  run(0x19, [2]);
  assert.deepEqual(read(2, 4), [0, 179, 105, 228]);

  assert.equal(
    surfaces.importRaw(
      5,
      4,
      1,
      1,
      pointer(
        Uint8Array.of(0x30, 0x20, 0x10, 0x30, 0x20, 0x10, 0x30, 0x20, 0x10, 0x30, 0x20, 0x10),
      ),
    ),
    1,
  );
  assert.equal(surfaces.importRaw(6, 4, 1, 2, dwords([0, 0, 0, 0])), 1);
  assert.equal(
    applyBurikoBitmapMask(surfaces.snapshot(6), surfaces.snapshot(5), surfaces.snapshot(2)),
    0,
  );
  assert.deepEqual(read(6, 4), [0x00102030, 0xb3102030, 0x69102030, 0xe4102030]);
});
