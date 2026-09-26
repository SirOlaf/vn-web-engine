import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BurikoLogicalSpatialManager,
  BurikoLogicalSpatialManagers,
} from '../dist/engines/buriko/native/logical-spatial.js';
import {BurikoLogicalSpatialCollision} from '../dist/engines/buriko/native/logical-spatial-collision.js';
import {nativeSpatialAngle} from '../dist/engines/buriko/bp/opcodes/native-math.js';
import {createGroupD0SpatialRecords} from '../dist/engines/buriko/native/group-d0-spatial.js';
import {createGroupD0SpatialCollision} from '../dist/engines/buriko/native/group-d0-spatial-collision.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';

function fixture() {
  const manager = new BurikoLogicalSpatialManager(),
    collision = new BurikoLogicalSpatialCollision(manager);
  const bytes = new Uint8Array(1024),
    view = new DataView(bytes.buffer),
    pointer = (offset) => ({bytes, offset});
  const create = (index, position, radius = 1, mask = 1, priority = 0) =>
    manager.createRecord(index, [...position, 0, 0, 0, radius, 0, 0], mask, priority);
  const collect = (
    source = [0, 0, 0, 0],
    target = [10, 0, 0, 0],
    check = 0,
    mask = 1,
    priority = 0,
    radius = 1,
  ) => {
    view.setUint32(4, 0x12345678, true);
    const result = collision.collect(
      pointer(100),
      pointer(4),
      source,
      target,
      radius,
      priority,
      -1,
      mask,
      check,
    );
    const count = view.getUint32(4, true);
    return {
      result,
      count,
      ids: count === 0x12345678 ? [] : [...new Uint32Array(bytes.buffer, 100, count)],
    };
  };
  return {manager, collision, bytes, view, pointer, create, collect};
}

test('atan2f follows measured float-return shortcuts, signed-zero quadrants and exact native table', () => {
  const view = new DataView(new ArrayBuffer(4));
  const fromBits = (value) => {
    view.setUint32(0, value, true);
    return view.getFloat32(0, true);
  };
  const asBits = (value) => {
    view.setFloat32(0, value, true);
    return view.getUint32(0, true);
  };
  // Independently executed native instruction results; several differ from f32(Math.atan2()).
  const cases = [
    [0x00000000, 0x80000000, 0x40490fdb],
    [0x80000000, 0x80000000, 0xc0490fdb],
    [0x80000000, 0x00000000, 0x80000000],
    [0x3f800000, 0x00000000, 0x3fc90fdb],
    [0x37000000, 0x3f7fffff, 0x37000001],
    [0xb7000000, 0x3f7fffff, 0xb7000001],
    [0x37800000, 0x3f7fffff, 0x37800001],
    [0x3f820000, 0x46202d43, 0x38cfc53a],
    [0x5676a896, 0x5e4746fd, 0x379e6f19],
    [0x91d52e3c, 0x188a346b, 0xb8c57096],
    [0xecd2d8e8, 0x74386727, 0xb8125b1b],
    [0xbb15a2d4, 0x421cb023, 0xb8747a74],
    [0x1, 0x7f7fffff, 0x0],
    [0x80000001, 0x7f7fffff, 0x80000000],
  ];
  for (const [y, x, expected] of cases)
    assert.equal(asBits(nativeSpatialAngle(fromBits(y), fromBits(x))), expected);
});

test('collision retains endpoint priority, strict tangency and its native null-count return bug', () => {
  const {collision, create, collect, pointer, view} = fixture();
  create(0, [10, 0, 0]);
  assert.deepEqual(collect(), {result: 0, count: 1, ids: [0]});
  assert.equal(
    collision.collect(pointer(100), null, [0, 0, 0, 0], [10, 0, 0, 0], 1, 0, -1, 1, 0),
    1,
  );
  assert.deepEqual(collect([9, 0, 0, 0], [10, 0, 0, 0], 0, 1, 1), {
    result: 1,
    count: 0x12345678,
    ids: [],
  });
  assert.deepEqual(collect([9, 0, 0, 0]), {result: 0, count: 1, ids: [0]});
  assert.deepEqual(collect([0, 0, 0, 0], [8, 0, 0, 0]), {result: 1, count: 0x12345678, ids: []});
  view.setUint32(4, 19, true);
  assert.equal(
    collision.collect(null, pointer(4), [0, -0, 0, 0], [-0, 0, 0, 0], 1, 0, -1, 1, 1),
    1,
  );
  assert.equal(view.getUint32(4, true), 19);
});

test('segment projections retain side scratch values across records and fault on native uninitialized reads', () => {
  const {manager, create, collect} = fixture();
  create(1, [5, 0, 0]);
  assert.deepEqual(collect([0, 0, 0, 0], [10, 0, 0, 0], 1), {result: 0, count: 1, ids: [1]});
  create(2, [-5, 0, 0]);
  // The second candidate reuses the first one's native stack scratch values.
  assert.deepEqual(collect([0, 0, 0, 0], [10, 0, 0, 0], 1), {result: 0, count: 2, ids: [1, 2]});
  manager.removeRecord(1);
  assert.throws(() => collect([0, 0, 0, 0], [10, 0, 0, 0], 1), /uninitialized projected-distance/);
  manager.removeRecord(2);
  create(3, [0, 0, 5]);
  assert.throws(() => collect([0, 0, 0, 0], [0, 0, 10, 0], 1), /uninitialized projected-distance/);
});

test('movement category masks require either a shared tag or both sides untagged', () => {
  const {create, collect} = fixture();
  create(0, [10, 0, 0], 1, 1);
  create(1, [10, 0, 0], 1, 0x101);
  create(2, [10, 0, 0], 1, 0x201);
  create(3, [10, 0, 0], 1, 0x301);
  assert.deepEqual(collect().ids, [0]);
  assert.deepEqual(collect(undefined, undefined, 0, 0x101).ids, [1, 3]);
  assert.deepEqual(collect(undefined, undefined, 0, 0x200).ids, [2, 3]);
  assert.deepEqual(collect(undefined, undefined, 0, 0x301).ids, [1, 2, 3]);
});

test('movement VM leaves retain distinct boolean/status paths and all argument ordering', () => {
  const {bytes, view} = fixture(),
    managers = new BurikoLogicalSpatialManagers();
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 64,
    moduleCapacity: 64,
    frameCapacity: 64,
  });
  const h = {thread, memory: new BurikoBpMemory(bytes)};
  const definitions = [
    ...createGroupD0SpatialRecords(managers),
    ...createGroupD0SpatialCollision(managers),
  ];
  const call = (secondary, ...args) => {
    for (const arg of args) push32(thread, arg);
    assert.equal(definitions.find((d) => d.secondary === secondary).execute(h), 0);
    return pop32(thread);
  };
  call(0x40, 16);
  const id = view.getUint32(16, true);
  for (const [index, point] of [
    [0, [10, 20, 30]],
    [1, [13, 24, 30]],
  ])
    assert.equal(
      call(0x60, id, index, ...[...point, 0, 0, 0, 1, 0, 0].map((v) => v * 65536), 1, 0),
      0,
    );
  assert.equal(call(0x70, id, 0, ...[13, 24, 30].map((v) => v * 65536), 1, 0), 0);
  assert.equal(call(0x71, 100, 4, id, 0, ...[13, 24, 30].map((v) => v * 65536), 1, 0), 0);
  assert.equal(view.getUint32(4, true), 1);
  assert.equal(view.getUint32(100, true), 1);
  assert.equal(call(0x71, 100, 4, id, 0, ...[10, 20, 30].map((v) => v * 65536), 1, 0), 0x1d);
  assert.equal(call(0x71, 0, 0, id, 0, ...[13, 24, 30].map((v) => v * 65536), 1, 0), 0x1d);
  assert.equal(call(0x70, id, 63, 0, 0, 0, 1, 0), 0x12);
  assert.equal(call(0x70, id + 1, 0, 0, 0, 0, 1, 0), 1);
  assert.equal(thread.stackIndex, 0);
});
