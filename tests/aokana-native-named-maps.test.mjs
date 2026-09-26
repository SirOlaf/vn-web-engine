import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoNamedValueMaps} from '../dist/engines/buriko/native/named-value-maps.js';
import {createGroup80NamedMaps} from '../dist/engines/buriko/native/group-80-named-maps.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

test('80 D0–D4 keep fixed-width maps, native stack order and insertion-order indexed reads', () => {
  const maps = new BurikoNamedValueMaps(),
    slots = createGroup80NamedMaps(maps);
  assert.equal(slots.length, 5);
  for (const slot of slots)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x80][slot.secondary]);
  const thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 8,
      moduleCapacity: 256,
      frameCapacity: 0,
    }),
    memory = new BurikoBpMemory(new Uint8Array(1)),
    context = {thread, memory};
  const call = (secondary, args) => {
    args.forEach((value) => push32(thread, value));
    assert.equal(slots.find((slot) => slot.secondary === secondary).execute(context), 0);
    return pop32(thread);
  };
  memory.writeU32(thread, 0x10000020, 0x000061);
  memory.writeU32(thread, 0x10000024, 0x000062);
  memory.writeU32(thread, 0x10000030, 0x11223344);
  memory.writeU32(thread, 0x10000034, 0x55667788);
  assert.equal(call(0xd0, [0x10000000, 4]), 0);
  const id = memory.readU32(thread, 0x10000000);
  assert.equal(id, 1);
  assert.equal(call(0xd2, [id, 0x10000020, 0x10000030]), 0);
  assert.equal(call(0xd2, [id, 0x10000024, 0x10000034]), 0);
  assert.equal(call(0xd4, [0x10000040, id, 0x10000024, 123]), 0);
  assert.equal(memory.readU32(thread, 0x10000040), 0x55667788);
  memory.writeU32(thread, 0x10000030, 0xaabbccdd);
  assert.equal(call(0xd2, [id, 0x10000020, 0x10000030]), 0);
  assert.equal(call(0xd4, [0x10000040, id, 0, 0]), 0);
  assert.equal(memory.readU32(thread, 0x10000040), 0xaabbccdd);
  assert.equal(call(0xd4, [0, id, 0x10000020, 0]), 0);
  assert.equal(call(0xd3, [id, 0x10000020]), 0);
  assert.equal(call(0xd4, [0x10000040, id, 0, 0]), 0);
  assert.equal(memory.readU32(thread, 0x10000040), 0x55667788);
  assert.equal(call(0xd1, [id]), 0);
  assert.equal(maps.find(id), null);
  assert.equal(thread.stackIndex, 0);
});

test('native registry clearing resets its counter while normal deletion preserves it', () => {
  const maps = new BurikoNamedValueMaps(),
    bytes = new Uint8Array(16),
    output = {bytes, offset: 0},
    view = new DataView(bytes.buffer);
  assert.equal(maps.create(output, 3), 0);
  const first = view.getUint32(0, true);
  assert.equal(first, 1);
  const key = {bytes: Uint8Array.of(0x83, 0x65, 0), offset: 0},
    source = {bytes: Uint8Array.of(1, 2, 3), offset: 0};
  assert.equal(maps.write(first, key, source), 0);
  source.bytes.fill(9);
  assert.equal(maps.read({bytes, offset: 4}, first, key, 0), 0);
  assert.deepEqual([...bytes.subarray(4, 7)], [1, 2, 3]);
  assert.equal(maps.destroy(first), 0);
  assert.equal(maps.create(output, 3), 0);
  assert.equal(view.getUint32(0, true), 2);
  maps.clear();
  assert.equal(maps.create(output, 3), 0);
  assert.equal(view.getUint32(0, true), 1);
});
