import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoStringLists} from '../dist/engines/buriko/native/string-lists.js';
import {createGroup80StringLists} from '../dist/engines/buriko/native/group-80-string-lists.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

const strings = (...values) => new TextEncoder().encode(values.join('\0') + '\0');
const pointer = (bytes) => ({bytes, offset: 0});

test('80 D8–DE preserve native list replacement, duplicate append indices, bytes and wrapper order', () => {
  const lists = new BurikoStringLists(),
    slots = createGroup80StringLists(lists);
  assert.equal(slots.length, 7);
  for (const slot of slots)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x80][slot.secondary]);
  const thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 8,
      moduleCapacity: 1024,
      frameCapacity: 0,
    }),
    memory = new BurikoBpMemory(new Uint8Array(1)),
    context = {thread, memory};
  const put = (address, bytes) => {
    const output = memory.resolve(thread, address);
    output.bytes.set(bytes, output.offset);
  };
  put(0x10000020, strings('alpha', 'beta', 'alpha'));
  put(0x10000080, strings('beta'));
  put(0x100000a0, strings('gamma'));
  const call = (secondary, args = []) => {
    args.forEach((value) => push32(thread, value));
    assert.equal(slots.find((slot) => slot.secondary === secondary).execute(context), 0);
    return secondary === 0xd8 ? undefined : pop32(thread);
  };
  assert.equal(call(0xda, [7, 3, 0x10000020]), 1);
  assert.equal(call(0xd9, [7]), 3);
  assert.equal(call(0xdc, [7, 0x10000080]), 1);
  assert.equal(call(0xdc, [7, 0x100000a0]), 3);
  assert.equal(call(0xd9, [7]), 4);
  assert.equal(call(0xdb, [0x10000200, 7]), 23);
  const packed = memory.resolve(thread, 0x10000200);
  assert.deepEqual(
    packed.bytes.slice(packed.offset, packed.offset + 23),
    strings('alpha', 'beta', 'alpha', 'gamma'),
  );
  assert.equal(call(0xdb, [0, 7]), 23);
  assert.equal(call(0xdd, [0x10000300, 7, 2]), 0);
  const selected = memory.resolve(thread, 0x10000300);
  assert.deepEqual(selected.bytes.slice(selected.offset, selected.offset + 6), strings('alpha'));
  assert.equal(call(0xde, [0x10000310, 7, 2]), 0);
  assert.equal(memory.readU32(thread, 0x10000310), 5);
  assert.equal(call(0xdc, [0x80000000, 0x100000a0]), 0);
  call(0xd8);
  assert.equal(lists.count(7), 0);
  assert.equal(lists.count(0x80000000), 1);
  assert.equal(thread.stackIndex, 0);
});

test('numbered lists own copied bytes and reset follows live links around the reserved list', () => {
  const lists = new BurikoStringLists(),
    source = strings('one', 'two');
  lists.append(1, pointer(strings('first')));
  lists.append(0x80000000, pointer(strings('reserved')));
  lists.replace(2, 2, pointer(source));
  lists.append(3, pointer(Uint8Array.of(0x83, 0x65, 0)));
  assert.equal(lists.append(3, pointer(Uint8Array.of(0x83, 0x65, 0))), 0);
  source.fill(0x7a);
  const output = new Uint8Array(32);
  assert.equal(lists.copyAll(pointer(output), 2), 8);
  assert.deepEqual(output.slice(0, 8), strings('one', 'two'));
  lists.reset(1);
  assert.deepEqual(
    [1, 2, 3, 0x80000000].map((id) => lists.count(id)),
    [0, 0, 0, 1],
  );
  lists.reset(0);
  assert.equal(lists.count(0x80000000), 0);
});
