import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaNativeSplines} from '../dist/engines/buriko/games/aokana/native/spline-registry.js';
import {createGroupC0Splines} from '../dist/engines/buriko/games/aokana/native/group-c0-splines.js';
import {decodeBwefPairs} from '../dist/engines/buriko/games/aokana/native/bwef.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';

function storage(size) {
  const bytes = new Uint8Array(size),
    view = new DataView(bytes.buffer);
  return {bytes, view, pointer: (offset = 0) => ({bytes, offset})};
}

test('C0 spline registry retains signed-bank IDs, validation precedence and uninitialized duration', () => {
  const splines = new AokanaNativeSplines(),
    first = splines.create(),
    second = splines.create(),
    points = storage(32),
    output = storage(32);
  assert.equal(first, 0x80000001);
  assert.equal(second, 0x80000002);
  assert.equal(splines.initialize(0, 1, null, 1), 2);
  assert.equal(splines.initialize(0, 2, null, 1), 3);
  assert.equal(splines.initialize(0, 2, null, 2), 1);
  assert.throws(() => splines.sample(null, first, 0), /uninitialized/);
  new Int32Array(points.bytes.buffer).set([0, 0, 0, 999, 100, -100, 50, 888]);
  assert.equal(splines.initialize(first, 2, points.pointer(), 10), 0);
  assert.equal(splines.sample(output.pointer(), first, 5), 0);
  assert.deepEqual([...new Int32Array(output.bytes.buffer, 0, 3)], [50, -50, 25]);
  assert.equal(splines.sample(null, first, 10), 4);
  assert.equal(splines.sample(null, 0, 0), 1);
  assert.equal(splines.remove(first), 0);
  assert.equal(splines.sample(null, first, 0), 1);
  assert.equal(splines.remove(first), 1);
  assert.equal(splines.remove(second), 0);
});

test('C0 spline initialization reads excess points while retaining the native 100-point cap', () => {
  const splines = new AokanaNativeSplines(),
    id = splines.create(),
    points = storage(101 * 16),
    output = storage(12);
  for (let i = 0; i < 101; i++) points.view.setInt32(i * 16, i * 10, true);
  assert.equal(splines.initialize(id, 101, points.pointer(), 100), 0);
  assert.equal(splines.sample(output.pointer(), id, 50), 0);
  assert.equal(output.view.getInt32(0, true), 495);
  assert.throws(() => splines.initialize(id, 102, points.pointer(), 100), /outside|range|bounds/i);
  // The failed native copy cleared the spline before its fault but did not replace the registry duration.
  assert.equal(splines.sample(output.pointer(), id, 50), 0xffffffff);
});

test('C0 spline wrappers preserve all four native stack contracts', () => {
  const memory = new AokanaBpMemory(new Uint8Array(256)),
    thread = new AokanaBpThread({id: 1, operandCapacity: 16, moduleCapacity: 0, frameCapacity: 0}),
    context = {memory, thread};
  const handlers = new Map(
    createGroupC0Splines(new AokanaNativeSplines()).map((slot) => [slot.secondary, slot.execute]),
  );
  const call = (opcode, args = []) => {
    args.forEach((value) => push32(thread, value));
    assert.equal(handlers.get(opcode)(context), 0);
    const result = pop32(thread);
    assert.equal(thread.stackIndex, 0);
    return result;
  };
  const id = call(0xc0),
    view = new DataView(memory.globalMemory.buffer);
  view.setInt32(64 + 16, 80, true);
  assert.equal(call(0xc2, [id, 2, 64, 4]), 0);
  assert.equal(call(0xc3, [128, id, 3]), 0);
  assert.equal(view.getInt32(128, true), 60);
  assert.equal(call(0xc1, [id]), 0);
});

test('BWEF parser validates signature then exact size and writes wrapping pairs before count', () => {
  const input = storage(0x128),
    output = storage(64);
  output.bytes.fill(0x55);
  assert.equal(decodeBwefPairs(null, null, input.bytes, input.bytes.length, 0), 0x80000002);
  input.view.setBigUint64(0, 0x2020202066657762n, true);
  input.view.setUint32(0x14, 2, true);
  assert.equal(decodeBwefPairs(null, null, input.bytes, input.bytes.length - 1, 0), 0x80000003);
  input.view.setInt32(0x18, -7, true);
  input.view.setInt32(0x120, 0x7fffffff, true);
  input.view.setInt32(0x124, -10, true);
  assert.equal(
    decodeBwefPairs(output.pointer(), output.pointer(32), input.bytes, input.bytes.length, 2),
    0,
  );
  assert.deepEqual([...new Int32Array(output.bytes.buffer, 0, 4)], [-2147483647, -7, -8, -7]);
  assert.equal(output.view.getInt32(32, true), 2);
  assert.equal(output.view.getUint32(16, true), 0x55555555);
  assert.equal(
    decodeBwefPairs(output.pointer(), output.pointer(), input.bytes, input.bytes.length, 2),
    0,
  );
  assert.equal(output.view.getInt32(0, true), 2);
  input.view.setUint32(0x14, 0, true);
  assert.equal(decodeBwefPairs(null, output.pointer(), input.bytes, 0x120, 2), 0);
  assert.equal(output.view.getInt32(0, true), 0);
  assert.throws(() => decodeBwefPairs(null, null, null, 0, 0), /unwritten resource pointer/);
});
