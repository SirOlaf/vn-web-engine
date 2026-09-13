import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AokanaLogicalSpatialManager,
  AokanaLogicalSpatialManagers,
} from '../dist/engines/buriko/games/aokana/native/logical-spatial.js';
import {AokanaLogicalSpatialQueries} from '../dist/engines/buriko/games/aokana/native/logical-spatial-queries.js';
import {createGroupD0SpatialQueries} from '../dist/engines/buriko/games/aokana/native/group-d0-spatial-queries.js';
import {createGroupD0SpatialRecords} from '../dist/engines/buriko/games/aokana/native/group-d0-spatial.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';

function fixture() {
  const manager = new AokanaLogicalSpatialManager(),
    queries = new AokanaLogicalSpatialQueries(manager),
    bytes = new Uint8Array(2048),
    view = new DataView(bytes.buffer);
  const pointer = (offset) => ({bytes, offset});
  const words = (offset, count) =>
    Array.from({length: count}, (_, i) => view.getInt32(offset + i * 4, true));
  const create = (
    id,
    point,
    mask = 1,
    radius = 1,
    direction = [0, 0, 0],
    offset = 0,
    queryRadius = 0,
  ) => {
    assert.equal(
      manager.createRecord(id, [...point, ...direction, radius, offset, queryRadius], mask, 0),
      0,
    );
  };
  return {manager, queries, bytes, view, pointer, words, create};
}

test('relative queries validate source then target and preserve native zero/overflow conversions', () => {
  const {queries, create, pointer, words, view} = fixture();
  create(0, [0, 0, 0]);
  create(1, [3, 4, 0]);
  assert.equal(queries.relativeToRecord(null, 2, 2), 0xa0000001);
  assert.equal(queries.relativeToRecord(null, 0, 2), 0xa0000002);
  assert.equal(queries.relativeToRecord(pointer(100), 0, 1), 0);
  assert.deepEqual(words(100, 5), [1, 39322, 52429, 0, 327680]);
  assert.equal(queries.relativeToRecord(pointer(100), 1, 1), 0);
  assert.deepEqual(words(100, 5), [1, 0, 0, 0, 0]);
  assert.equal(queries.relativeToPosition(pointer(100), 1, 0, 0, 0), 0);
  assert.deepEqual(words(100, 5), [-1, -39322, -52429, 0, 327680]);
  create(2, [-32768, -32768, -32768]);
  assert.equal(queries.relativeToPosition(pointer(100), 2, 32768, 32768, 32768), 0);
  assert.deepEqual(words(100, 5), [-1, 37837, 37837, 37837, -2147483648]);
  const short = {bytes: new Uint8Array(4), offset: 0};
  assert.throws(() => queries.relativeToRecord(short, 0, 1), /access|range|bounds/i);
  assert.equal(new DataView(short.bytes.buffer).getUint32(0, true), 1);
  assert.equal(view.getInt32(100, true), -1);
});

test('neighbors order by native float distance then ascending IDs and only filter the low mask byte', () => {
  const {queries, create, pointer, words, view} = fixture();
  create(4, [0, 0, 0]);
  create(8, [-3, -4, 0], 0x101);
  create(1, [3, 4, 0], 0x201);
  create(2, [0, 0, 0], 2);
  create(3, [10, 0, 0], 1);
  assert.equal(queries.neighbors(pointer(100), pointer(4), 4, 0x100), 0);
  assert.equal(view.getUint32(4, true), 4);
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => words(100 + i * 20, 1)[0]),
    [2, 1, 8, 3],
  );
  assert.deepEqual(words(100, 5), [2, 0, 0, 0, 0]);
  assert.equal(queries.neighbors(pointer(100), pointer(100), 4, 1), 0);
  assert.deepEqual(words(100, 5), [3, 39322, 52429, 0, 327680]); // Count overwrites first ID last.
  assert.equal(queries.neighbors(null, pointer(4), 4, 4), 0);
  assert.equal(view.getUint32(4, true), 0);
  assert.throws(() => queries.neighbors(null, pointer(4), 4, 1), /null query/);
});

test('overlap categories preserve the native asymmetry and exclude tangent spheres', () => {
  const {queries, create, pointer, words, view} = fixture();
  create(0, [0, 0, 0], 1);
  create(1, [0, 0, 0], 0x101);
  create(2, [0, 0, 0], 0x201);
  create(3, [0, 0, 0], 0x301);
  create(4, [2, 0, 0], 1);
  create(5, [0, 0, 0], 2);
  for (const [mask, expected] of [
    [1, [0]],
    [0x101, [0, 1, 3]],
    [0x201, [0, 2, 3]],
    [0x301, [0, 1, 2, 3]],
    [0x100, [0, 1, 3, 5]],
  ]) {
    assert.equal(queries.overlaps(pointer(100), pointer(4), [0, 0, 0, 0], 1, -1, mask), 0);
    assert.deepEqual(words(100, view.getUint32(4, true)), expected);
  }
  assert.equal(queries.overlaps(pointer(100), pointer(100), [0, 0, 0, 0], 1, 0, 0x301), 0);
  assert.deepEqual(words(100, 3), [3, 2, 3]);
  // There is no sign check for query radius: native squares the sum.
  assert.equal(queries.overlaps(pointer(100), pointer(4), [0, 0, 0, 0], -3, -1, 1), 0);
  assert.deepEqual(words(100, view.getUint32(4, true)), [0]);
});

test('record overlap uses the derived offset and third property, retaining stale derived offsets', () => {
  const {manager, queries, create, pointer, words, view} = fixture();
  create(0, [10, 20, 30], 1, 10, [1, 0, 0], 4, 2);
  create(1, [15, 20, 30]);
  create(2, [10, 20, 30]);
  assert.equal(queries.overlapsAtRecord(pointer(100), pointer(4), 0, 1), 0);
  assert.deepEqual(words(100, view.getUint32(4, true)), [1]);
  manager.setProperty(0, 1, 20 * 65536);
  queries.overlapsAtRecord(pointer(100), pointer(4), 0, 1);
  assert.deepEqual(words(100, view.getUint32(4, true)), [1]);
  manager.setDirection(0, 1, 0, 0);
  queries.overlapsAtRecord(null, pointer(4), 0, 1);
  assert.equal(view.getUint32(4, true), 0);
  assert.equal(queries.overlapsAtRecord(null, null, 63, 1), 0xa0000001);
});

test('query wrappers consume all arguments in native order and retain lifetime references on output faults', () => {
  const {bytes, view, words} = fixture(),
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
    ...createGroupD0SpatialQueries(managers),
  ];
  const call = (secondary, ...args) => {
    for (const arg of args) push32(thread, arg);
    assert.equal(definitions.find((d) => d.secondary === secondary).execute(h), 0);
    return pop32(thread);
  };
  assert.equal(call(0x40, 16), 0);
  const id = view.getUint32(16, true);
  for (const [index, point] of [
    [0, [10, 20, 30]],
    [1, [13, 24, 30]],
  ]) {
    assert.equal(
      call(0x60, id, index, ...[...point, 1, 0, 0, 1, 0, 10].map((n) => n * 65536), 1, 0),
      0,
    );
  }
  assert.equal(call(0x79, 100, id, 0, 1), 0);
  assert.deepEqual(words(100, 5), [1, 39322, 52429, 0, 327680]);
  assert.equal(call(0x7a, 100, id, 0, ...[13, 24, 30].map((n) => n * 65536)), 0);
  assert.deepEqual(words(100, 5), [-1, 39322, 52429, 0, 327680]);
  assert.equal(call(0x78, 100, 4, id, 0, 1), 0);
  assert.equal(view.getUint32(4, true), 1);
  assert.equal(call(0x74, 100, 4, id, 0, 1), 0);
  assert.deepEqual(words(100, view.getUint32(4, true)), [1]);
  assert.equal(call(0x75, 100, 4, id, ...[13, 24, 30, 1].map((n) => n * 65536), -1, 1), 0);
  assert.deepEqual(words(100, view.getUint32(4, true)), [1]);
  assert.equal(call(0x79, 0, id, 63, 63), 0x12);
  assert.equal(call(0x79, 0, id, 0, 63), 0x13);
  assert.equal(call(0x79, 0, id + 1, 0, 1), 1);
  assert.equal(thread.stackIndex, 0);
  assert.throws(() => call(0x79, 0, id, 0, 1), /null query/);
  assert.equal(call(0x41, id), 0x17);
});
