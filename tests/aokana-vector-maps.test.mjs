import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {displaceBurikoBitmap} from '../dist/engines/buriko/native/bitmap-displacement.js';
import {bitmapWrite32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {createGroup92VectorMaps} from '../dist/engines/buriko/native/group-92-vector-maps.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

test('92 generated linear and radial maps drive actual nearest displacement', () => {
  const compositor = new BurikoBitmapCompositor();
  compositor.filterProperty = 1;
  const surfaces = new BurikoSurfaces(
    new BurikoNativeFonts(new BurikoNativeText()),
    compositor,
    new BurikoDistributedAllocator(1),
  );
  assert.equal(surfaces.allocate(1, 3, 1, 6), 1);
  assert.equal(surfaces.allocate(2, 7, 4, 2), 1);
  assert.equal(surfaces.allocate(3, 3, 1, 2), 1);
  const map = surfaces.snapshot(1),
    source = surfaces.snapshot(2),
    destination = surfaces.snapshot(3);
  map.storage.bytes.fill(0xa5);
  map.storage.written(0, map.storage.bytes.length);
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 7; x++)
      bitmapWrite32(source, source.offset + y * source.stride + x * 4, y * 7 + x + 1);
  const table = new Uint32Array(16);
  for (const [phase, coefficient] of [
    [4, 2],
    [8, 4],
    [12, 6],
  ])
    table[phase] = coefficient | (coefficient << 16);
  const slots = createGroup92VectorMaps(surfaces, {
    threadFatal() {
      assert.fail('ordinary map generation succeeds');
    },
  });
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 32,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: new BurikoBpMemory(new Uint8Array(64)), diagnostics: {}};
  for (const slot of slots)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x92][slot.secondary]);
  const run = (secondary, ...values) => {
    values.forEach((value) => push32(thread, value));
    assert.equal(slots.find((slot) => slot.secondary === secondary).execute(context), 0);
    assert.equal(thread.stackIndex, 0);
  };
  const phases = () =>
    [0, 1, 2].map((x) => map.storage.view.getUint16(map.offset + x * 6 + 4, true));
  const sample = (expected) => {
    assert.equal(displaceBurikoBitmap(compositor, destination, source, source, map, table, 0), 0);
    assert.deepEqual(
      [0, 1, 2].map((x) => destination.storage.view.getUint32(destination.offset + x * 4, true)),
      expected,
    );
  };
  for (const [direction, phase, expected] of [
    [0, [0, 0, 0], [1, 2, 3]],
    [1, [0, 4, 8], [1, 9, 17]],
    [2, [0, 4, 8], [1, 3, 5]],
    [3, [0, 0, 0], [1, 2, 3]],
  ]) {
    run(0x11, 1, direction);
    assert.deepEqual(phases(), phase);
    for (let x = 0; x < 3; x++)
      assert.deepEqual(
        [
          map.storage.view.getInt16(map.offset + x * 6, true),
          map.storage.view.getInt16(map.offset + x * 6 + 2, true),
        ],
        direction % 2 === 0 ? [32767, 0] : [0, 32767],
      );
    sample(expected);
  }
  // Positive radii1,2,3. Phase-selected coefficients2,4,6 round to shifts1,2,3.
  run(0x10, 1, 0, -1, 0, 0);
  assert.deepEqual(phases(), [4, 8, 12]);
  sample([2, 4, 6]);
  run(0x10, 1, 1, -1, 0, 0);
  assert.deepEqual(phases(), [4, 8, 12]);
  sample([8, 16, 24]);
  run(0x10, 1, 0, -1, 0, 2);
  assert.deepEqual(phases(), [4, 0, 4]);
  sample([2, 2, 4]);
});
