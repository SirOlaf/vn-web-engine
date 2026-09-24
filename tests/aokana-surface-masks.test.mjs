import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {applyAokanaBitmapMask} from '../dist/engines/buriko/games/aokana/native/bitmap-alpha-mask.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaEngineErrors} from '../dist/engines/buriko/games/aokana/native/engine-errors.js';
import {AokanaBpDiagnostics} from '../dist/engines/buriko/games/aokana/native/diagnostics.js';
import {createGroup92SurfaceMasks} from '../dist/engines/buriko/games/aokana/native/group-92-surface-masks.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

const pointer = (bytes) => ({bytes, offset: 0});
const dwords = (values) => {
  const bytes = new Uint8Array(values.length * 4),
    view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value, true));
  return pointer(bytes);
};

test('surface mask opcodes convert RGB and RGBA, invert and feed actual alpha-mask rendering', () => {
  const text = new AokanaNativeText(),
    compositor = new AokanaBitmapCompositor();
  const surfaces = new AokanaSurfaces(
    new AokanaNativeFonts(text),
    compositor,
    new AokanaDistributedAllocator(1),
  );
  const errors = new AokanaEngineErrors(
    {text},
    {show: () => assert.fail('Unexpected ordinary mask error')},
    Uint8Array.of(0),
    Uint8Array.of(0),
  );
  const memory = new AokanaBpMemory(new Uint8Array(32));
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const diagnostics = new AokanaBpDiagnostics(() => assert.fail('Unexpected diagnostic'));
  const context = {thread, memory, diagnostics};
  const definitions = createGroup92SurfaceMasks(surfaces, errors);
  const slots = new Map(definitions.map((slot) => [slot.secondary, slot]));
  for (const slot of definitions)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x92][slot.secondary]);
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
    applyAokanaBitmapMask(surfaces.snapshot(6), surfaces.snapshot(5), surfaces.snapshot(2)),
    0,
  );
  assert.deepEqual(read(6, 4), [0x00102030, 0xb3102030, 0x69102030, 0xe4102030]);
});
