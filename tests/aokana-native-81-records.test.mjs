import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoNativeRecordBuffers} from '../dist/engines/buriko/native/record-buffers.js';
import {
  createGroup81Records,
  group81Disabled,
} from '../dist/engines/buriko/native/group-81-records.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';

function fixture() {
  const bytes = new Uint8Array(2048),
    records = new BurikoNativeRecordBuffers(),
    view = new DataView(bytes.buffer);
  return {bytes, records, view, pointer: (offset) => ({bytes, offset})};
}

test('record sets preserve native validation precedence, slot reuse and destructive replacement', () => {
  const {bytes, records, view, pointer} = fixture();
  assert.equal(records.create(null, 0), 0x80000001);
  assert.equal(records.create(null, 1), 0x80000001);
  assert.equal(records.create(pointer(0), 2), 0);
  const id = view.getUint32(0, true);
  bytes.set([11, 22, 33, 44], 100);
  assert.equal(records.write(pointer(4), 999, 0, null, 0), 0x80000002);
  assert.equal(records.write(pointer(4), id, 99, pointer(100), 0), 0x80000003);
  assert.equal(records.write(pointer(4), id, 99, pointer(100), 4), 0);
  assert.equal(view.getUint32(4, true), 0);
  assert.equal(records.write(pointer(4), id, 99, pointer(100), 3), 0);
  assert.equal(view.getUint32(4, true), 1);
  assert.equal(records.write(pointer(4), id, 99, pointer(100), 2), 0);
  assert.equal(view.getUint32(4, true), 2);
  assert.equal(records.remove(id, 1), 0);
  assert.equal(records.remove(id, 1), 0x80000004);
  assert.equal(records.write(pointer(4), id, 0, pointer(100), 1), 0);
  assert.equal(view.getUint32(4, true), 1);
  assert.equal(records.write(null, id, 9, pointer(100), 3), 0);
  assert.equal(records.enumerate(pointer(200), pointer(8), id), 0);
  assert.equal(view.getUint32(8, true), 4);
  assert.deepEqual([...new Uint32Array(bytes.buffer, 200, 8)], [0, 4, 1, 1, 2, 2, 9, 3]);
  assert.equal(records.write(null, id, 9, pointer(100), 0), 0x80000003);
  assert.equal(records.read(null, pointer(8), id, 9), 0);
  assert.equal(view.getUint32(8, true), 3);
  assert.equal(records.destroy(id), 0);
  assert.equal(records.destroy(id), 0x80000002);
});

test('record outputs preserve byte snapshots, alias write order and deferred null faults', () => {
  const {bytes, records, view, pointer} = fixture();
  records.create(pointer(0), 2);
  const id = view.getUint32(0, true);
  bytes.set([7, 8, 9, 10, 11, 12], 100);
  records.write(null, id, 1, pointer(100), 6);
  bytes.fill(99, 100, 106);
  assert.equal(records.read(pointer(200), pointer(202), id, 1), 0);
  assert.deepEqual([...bytes.subarray(200, 206)], [7, 8, 6, 0, 0, 0]);
  assert.equal(records.read(null, null, id, 0), 0x80000004);
  assert.equal(records.read(null, null, 999, 1), 0x80000002);
  assert.throws(() => records.read(null, null, id, 1), /null DWORD output/);
  assert.equal(records.enumerate(pointer(300), pointer(300), id), 0);
  assert.deepEqual([...new Uint32Array(bytes.buffer, 300, 2)], [1, 6]);
  assert.equal(records.remove(id, 1), 0);
  assert.equal(records.enumerate(null, pointer(8), id), 0);
  assert.equal(view.getUint32(8, true), 0);
});

test('record wrappers use the native five-argument write ABI and unchanged status words', () => {
  const {bytes, records, pointer, view} = fixture();
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 64,
    moduleCapacity: 64,
    frameCapacity: 64,
  });
  const memory = new BurikoBpMemory(bytes),
    h = {thread, memory},
    definitions = createGroup81Records(records);
  const call = (secondary, ...args) => {
    for (const arg of args) push32(thread, arg);
    assert.equal(definitions.find((d) => d.secondary === secondary).execute(h), 0);
    return pop32(thread);
  };
  assert.equal(call(0xd0, 16, 2), 0);
  const id = view.getUint32(16, true);
  bytes.set([1, 2, 3], 100);
  assert.equal(call(0xd2, 20, id, 57, 100, 3), 0);
  assert.equal(view.getUint32(20, true), 0);
  assert.equal(call(0xd4, 200, 24, id, 0), 0);
  assert.deepEqual([...bytes.subarray(200, 203)], [1, 2, 3]);
  assert.equal(view.getUint32(24, true), 3);
  assert.equal(call(0xd5, 300, 28, id), 0);
  assert.equal(view.getUint32(28, true), 1);
  assert.deepEqual([...new Uint32Array(bytes.buffer, 300, 2)], [0, 3]);
  assert.equal(call(0xd3, id, 0), 0);
  assert.equal(call(0xd1, id), 0);
});

test('C0640 clears the same Bank 81 record-set owner before the next program', () => {
  const {bytes, records, pointer, view} = fixture();
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 64,
    moduleCapacity: 64,
    frameCapacity: 64,
  });
  const definitions = createGroup81Records(records);
  const h = {thread, memory: new BurikoBpMemory(bytes)};
  const call = (secondary, ...args) => {
    for (const arg of args) push32(thread, arg);
    assert.equal(definitions.find((entry) => entry.secondary === secondary).execute(h), 0);
    return pop32(thread);
  };
  assert.equal(call(0xd0, 16, 2), 0);
  const oldId = view.getUint32(16, true);
  bytes.set([41, 42], 100);
  assert.equal(call(0xd2, 20, oldId, 0, 100, 2), 0);
  records.clear();
  assert.equal(call(0xd4, 200, 24, oldId, 0), 0x80000002);
  assert.equal(call(0xd0, 16, 2), 0);
  assert.equal(view.getUint32(16, true), oldId);
  assert.equal(call(0xd5, 200, 24, oldId), 0);
  assert.equal(view.getUint32(24, true), 0);
});

test('four disabled native services still pop and resolve arguments before returning one', () => {
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 64,
    moduleCapacity: 64,
    frameCapacity: 64,
  });
  const calls = [],
    h = {
      thread,
      memory: {
        resolve(_thread, address) {
          calls.push(address);
          return null;
        },
      },
    };
  for (const definition of group81Disabled) {
    push32(thread, 16);
    push32(thread, 32);
    calls.length = 0;
    assert.equal(definition.execute(h), 0);
    assert.equal(pop32(thread), 1);
    assert.equal(thread.stackIndex, 0);
    assert.deepEqual(calls, (definition.secondary & 1) === 0 ? [16] : [32, 16]);
  }
});
