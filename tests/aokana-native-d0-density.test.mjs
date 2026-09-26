import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AokanaLogicalSpatialManager,
  AokanaLogicalSpatialManagers,
} from '../dist/engines/buriko/games/aokana/native/logical-spatial.js';
import {AokanaLogicalSpatialDensity} from '../dist/engines/buriko/games/aokana/native/logical-spatial-density.js';
import {createGroupD0SpatialDensity} from '../dist/engines/buriko/games/aokana/native/group-d0-spatial-density.js';
import {createGroupD0SpatialRecords} from '../dist/engines/buriko/games/aokana/native/group-d0-spatial.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';

function fixture() {
  const manager = new AokanaLogicalSpatialManager(),
    density = new AokanaLogicalSpatialDensity(manager);
  const bytes = new Uint8Array(256),
    output = {bytes, offset: 100},
    words = () => [...new Int32Array(bytes.buffer, 100, 4)];
  const create = (index, x, y, weight = 1, radius = 10, mask = 1) => {
    manager.createRecord(index, [x, y, 0, 0, 0, 0, 1, 0, 0], mask, 0);
    manager.setProperty(index, 5, radius * 65536);
    manager.setProperty(index, 6, weight * 65536);
  };
  return {manager, density, bytes, output, words, create};
}

test('density validates native selector/dimensions in order without writing failed results', () => {
  const {density, output, bytes, words, create} = fixture();
  bytes.fill(0x55);
  assert.equal(density.query(null, 0, 0, 0, 0, 1, -1, 0), 0xa0000007);
  assert.equal(density.query(null, 0, 0, 0, 0, 0, -1, 0), 0xa0000008);
  assert.equal(density.query(null, 1, 0, 0, 0, 0, -1, 0), 0xa0000009);
  assert.equal(density.query(null, 1, 1, 1, 0, 0, -1, 0), 0xa000000a);
  assert.equal(density.query(output, 10, 4, 4, 1, 0, -1, 0), 0xa000000b);
  assert.deepEqual(words(), new Array(4).fill(0x55555555));
  create(0, 2, 2);
  assert.equal(density.query(output, 10, 4, 4, 1, 0, 0, 0), 0xa000000b);
  assert.equal(density.query(output, 10, 4, 4, 1, 0, -1, 2), 0xa000000b);
  assert.throws(() => density.query(null, 10, 4, 4, 1, 0, -1, 0), /null vector/);
});

test('density emits coarse cell centers or refined radial sample maxima and all four vector words', () => {
  const {density, output, words, create, manager} = fixture();
  create(0, 2, 2);
  assert.equal(density.query(output, 10, 4, 4, 1, 0, -1, 1), 0);
  assert.deepEqual(words(), [5 * 65536, 5 * 65536, 0, 0]);
  assert.equal(density.query(output, 10, 4, 4, 2, 0, -1, 1), 0);
  assert.deepEqual(words(), [2.5 * 65536, 2.5 * 65536, 0, 0]);
  manager.setProperty(0, 5, 0);
  assert.equal(density.query(output, 10, 4, 4, 2, 0, -1, 1), 0xa000000b);
  assert.deepEqual(words(), [2.5 * 65536, 2.5 * 65536, 0, 0]);
  // Radius zero at an exact sample creates NaN via the native reciprocal sequence.
  manager.setPosition(0, 2.5, 2.5, 0);
  assert.equal(density.query(output, 10, 4, 4, 2, 0, -1, 1), 0xa000000b);
});

test('coarse ties use native row-zero and column-zero sample locations', () => {
  const {density, output, words, create} = fixture();
  create(0, -5, 10, 5);
  create(1, 5, 10, 5);
  create(2, -15, -10, 3);
  create(3, 15, -10, 4);
  assert.equal(density.query(output, 10, 4, 3, 1, 0, -1, 1), 0);
  assert.deepEqual(words(), [5 * 65536, 10 * 65536, 0, 0]);
});

test('coarse cell arithmetic retains signed-word saturation and width truncation', () => {
  const {density, output, words, create, manager} = fixture();
  create(0, 0, 0);
  assert.equal(density.query(output, 1, 65536, 1, 1, 0, -1, 1), 0);
  assert.deepEqual(words(), [-32768, 0, 0, 0]);
  // Stay above the integer boundary: refined RCP(1) is just below 1.
  manager.setPosition(0, -16384, 0.5, 0);
  assert.throws(() => density.query(output, 1, 32768, 2, 1, 0, -1, 1), /outside its allocation/);
});

test('D07B consumes twelve scalars plus output and preserves four discarded arguments', () => {
  const {bytes} = fixture(),
    view = new DataView(bytes.buffer),
    managers = new AokanaLogicalSpatialManagers();
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 64,
    moduleCapacity: 64,
    frameCapacity: 64,
  });
  const h = {thread, memory: new AokanaBpMemory(bytes)};
  const definitions = [
    ...createGroupD0SpatialRecords(managers),
    ...createGroupD0SpatialDensity(managers),
  ];
  const call = (secondary, ...args) => {
    for (const arg of args) push32(thread, arg);
    assert.equal(definitions.find((d) => d.secondary === secondary).execute(h), 0);
    return pop32(thread);
  };
  call(0x40, 16);
  const id = view.getUint32(16, true);
  call(0x60, id, 0, ...[2, 2, 0, 0, 0, 0, 1, 0, 0].map((v) => v * 65536), 1, 0);
  call(0x62, id, 0, 6, 65536);
  assert.equal(
    call(0x7b, 100, id, 0xaaaaaaaa, 0xbbbbbbbb, 0xcccccccc, 10, 4, 4, 0xdddddddd, 1, 0, -1, 0),
    0,
  );
  assert.deepEqual([...new Int32Array(bytes.buffer, 100, 4)], [5 * 65536, 5 * 65536, 0, 0]);
  assert.equal(call(0x7b, 0, id, 0, 0, 0, 0, 0, 0, 0, 0, 1, -1, 0), 0x18);
  assert.equal(call(0x7b, 0, id + 1, 0, 0, 0, 10, 4, 4, 0, 1, 0, -1, 0), 1);
  assert.equal(thread.stackIndex, 0);
});
