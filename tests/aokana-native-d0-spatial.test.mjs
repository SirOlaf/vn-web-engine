import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AokanaLogicalSpatialManager,
  AokanaLogicalSpatialManagers,
} from '../dist/engines/buriko/games/aokana/native/logical-spatial.js';
import {createGroupD0SpatialRecords} from '../dist/engines/buriko/games/aokana/native/group-d0-spatial.js';
import {aokanaLogicalStatus} from '../dist/engines/buriko/games/aokana/native/logical-status.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';

function fixture() {
  const manager = new AokanaLogicalSpatialManager(),
    bytes = new Uint8Array(1024),
    view = new DataView(bytes.buffer);
  const pointer = (offset) => ({bytes, offset});
  const create = (index, direction = [1, 0, 0]) =>
    manager.createRecord(index, [0, 0, 0, ...direction, 1, 2, 3], 1, 0);
  const children = (index, group) => {
    const result = manager.copyChildren(pointer(100), pointer(4), index, group);
    return {
      result,
      values:
        result === 0
          ? Array.from({length: view.getUint32(4, true)}, (_, i) =>
              view.getUint32(100 + i * 4, true),
            )
          : [],
    };
  };
  const parent = (index, group) => {
    assert.equal(manager.getParent(pointer(4), index, group), 0);
    return view.getUint32(4, true);
  };
  return {manager, bytes, view, pointer, create, children, parent};
}

test('spatial record growth precedes native property validation and zero direction still creates', () => {
  const {manager, create} = fixture();
  assert.equal(manager.createRecord(127, [0, 0, 0, 0, 0, 0, 0, 0, 0], 1, 0), 0xa0000002);
  assert.equal(manager.capacity, 128);
  assert.equal(manager.record(127), undefined);
  assert.equal(manager.createRecord(128, [0, 0, 0, 0, 0, 0, 1, 0, 0], 256, 0), 0xa0000003);
  assert.equal(manager.capacity, 256);
  assert.equal(manager.createRecord(4096, [], 0, 0), 0xa0000001);
  assert.equal(create(3, [0, 0, 0]), 0);
  assert.deepEqual([...manager.vector(3, true)], [0, 0, 0, 0]);
  assert.equal(manager.setDirection(3, 0, 0, 0), 0xa0000002);
  assert.equal(manager.setDirection(3, 3, 4, 0), 0);
  const direction = manager.vector(3, true),
    record = manager.record(3);
  assert.ok(Math.abs(direction[0] - 0.6) < 1e-6);
  assert.ok(Math.abs(direction[1] - 0.8) < 1e-6);
  assert.equal(record.view.getFloat32(0x70, true), Math.fround(direction[0] * 2));
});

test('spatial coordinates snap inclusive tolerance and property writes leave derived vectors unchanged', () => {
  const {manager, create, pointer, view} = fixture();
  create(0);
  manager.setPosition(0, 4 / 65536, 5 / 65536, 1 - 4 / 65536);
  assert.deepEqual([...manager.vector(0, false)], [0, 5 / 65536, 1, 0]);
  const previous = [...manager.vector(0, true)];
  manager.setProperty(0, 1, 10 * 65536);
  assert.equal(manager.getProperty(pointer(4), 0, 1), 0);
  assert.equal(view.getUint32(4, true), 10 * 65536);
  assert.deepEqual([...manager.vector(0, true)], previous);
  // Derived offset vector is refreshed only when direction is set.
  assert.ok(manager.record(0).view.getFloat32(0x70, true) < 3);
  manager.setDirection(0, 1, 0, 0);
  assert.ok(manager.record(0).view.getFloat32(0x70, true) > 9);
  manager.setProperty(0, 3, 0x87654321);
  manager.getProperty(pointer(4), 0, 3);
  assert.equal(view.getUint32(4, true), 0x87654321);
  assert.equal(manager.setProperty(0, 7, 0), 0xa0000002);
  assert.equal(manager.getProperty(null, 1000, 7), 0xa0000001);
});

test('spatial parent groups reuse holes and distinguish replacement from explicit deletion', () => {
  const {manager, create, children, parent} = fixture();
  for (let i = 0; i < 5; i++) create(i);
  manager.setParent(1, 0, 0);
  manager.setParent(2, 0, 0);
  manager.setParent(3, 0, 0);
  manager.setParent(2, 0, 0xffffffff);
  manager.setParent(4, 0, 0);
  assert.deepEqual(children(0, 0).values, [1, 4, 3]);
  assert.equal(manager.record(0).incoming[0].length, 64);
  manager.setParent(1, 1, 2);
  assert.equal(parent(1, 0), 0);
  assert.equal(parent(1, 1), 2);
  assert.equal(manager.setParent(1, 0, 1), 0xa0000002);
  assert.equal(parent(1, 0), 0);
  assert.equal(manager.setParent(1, 2, 0), 0xa0000005);
  create(0);
  assert.deepEqual(children(0, 0).values, []);
  assert.equal(parent(1, 0), 0);
  manager.setParent(1, 0, 0);
  assert.deepEqual(children(0, 0).values, [1]);
  assert.equal(manager.removeRecord(0), 0);
  assert.equal(parent(1, 0), 0xffffffff);
  // Other stale links created by native memset replacement are still retained.
  assert.equal(parent(3, 0), 0);
  assert.equal(manager.removeRecord(2), 0);
  assert.equal(parent(1, 1), 0xffffffff);
});

test('spatial children enumeration stores data first and the count last', () => {
  const {manager, create, pointer, view} = fixture();
  create(0);
  create(1);
  create(2);
  manager.setParent(1, 0, 0);
  manager.setParent(2, 0, 0);
  assert.equal(manager.copyChildren(pointer(100), pointer(100), 0, 0), 0);
  assert.deepEqual([view.getUint32(100, true), view.getUint32(104, true)], [2, 2]);
  assert.equal(manager.copyChildren(null, pointer(4), 0, 0), 0);
  assert.equal(view.getUint32(4, true), 2);
});

test('spatial VM wrappers preserve float argument order, three-word vectors and release timing', () => {
  const {bytes, view} = fixture(),
    managers = new AokanaLogicalSpatialManagers();
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 64,
    moduleCapacity: 64,
    frameCapacity: 64,
  });
  const memory = new AokanaBpMemory(bytes),
    h = {thread, memory},
    definitions = createGroupD0SpatialRecords(managers);
  const call = (secondary, ...args) => {
    for (const arg of args) push32(thread, arg);
    assert.equal(definitions.find((d) => d.secondary === secondary).execute(h), 0);
    return pop32(thread);
  };
  assert.equal(call(0x40, 16), 0);
  const id = view.getUint32(16, true);
  const create = (index) =>
    call(0x60, id, index, ...[10, 20, 30, 1, 0, 0, 2, 3, 4].map((x) => x * 65536), 1, 7);
  assert.equal(create(0), 0);
  assert.equal(create(1), 0);
  view.setUint32(112, 0x12345678, true);
  assert.equal(call(0x65, 100, id, 0), 0);
  assert.deepEqual(
    [...new Uint32Array(bytes.buffer, 100, 4)],
    [655360, 1310720, 1966080, 0x12345678],
  );
  assert.equal(call(0x64, id, 0, 1, 2, 3), 0);
  assert.equal(call(0x66, id, 0, 0, 65536, 0), 0);
  assert.equal(call(0x67, 100, id, 0), 0);
  assert.deepEqual([...new Uint32Array(bytes.buffer, 100, 3)], [0, 65536, 0]);
  assert.equal(call(0x62, id, 0, 4, 0xabcdef01), 0);
  assert.equal(call(0x63, 100, id, 0, 4), 0);
  assert.equal(view.getUint32(100, true), 0xabcdef01);
  assert.equal(call(0x68, id, 1, 0, 0), 0);
  assert.equal(call(0x69, 100, id, 1, 0), 0);
  assert.equal(view.getUint32(100, true), 0);
  assert.equal(call(0x6a, 100, 20, id, 0, 0), 0);
  assert.equal(view.getUint32(100, true), 1);
  assert.equal(view.getUint32(20, true), 1);
  assert.equal(call(0x61, id, 1), 0);
  assert.throws(() => call(0x65, 0, id, 0), /null vector output/);
  assert.equal(call(0x41, id), 0); // Vector output happens after the native release.
  assert.equal(call(0x41, id), 1);
  assert.equal(call(0x60, 999, 0, ...new Array(11).fill(0)), 1);
  assert.equal(thread.stackIndex, 0);
});

test('logical status translation retains every native family and unknown statuses', () => {
  assert.equal(aokanaLogicalStatus(1), 0x1d);
  for (let i = 0; i <= 11; i++) assert.equal(aokanaLogicalStatus(0x80000000 + i), i + 1);
  assert.equal(aokanaLogicalStatus(0x90000002), 0x10);
  assert.equal(aokanaLogicalStatus(0x90000003), 0x11);
  [1, 0x12, 0x13, 0x14, 8, 0x15, 0x16, 0x18, 0x19, 0x1a, 0x1b, 0x1c].forEach((expected, i) =>
    assert.equal(aokanaLogicalStatus(0xa0000000 + i), expected),
  );
  assert.equal(aokanaLogicalStatus(0xfffffffe), 0xfffffffe);
  assert.equal(aokanaLogicalStatus(0x8000000c), 0xffffffff);
});
