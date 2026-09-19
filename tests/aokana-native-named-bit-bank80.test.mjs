import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createGroup80NamedBitArrays} from '../dist/engines/buriko/games/aokana/native/group-80-named-bit-arrays.js';
import {AokanaNamedBitArrays} from '../dist/engines/buriko/games/aokana/native/named-bit-arrays.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

test('80 88-8B share one MSB-first named-bit owner and preserve native wrapper order', () => {
  const bits = new AokanaNamedBitArrays(),
    slots = createGroup80NamedBitArrays(bits),
    thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    memory = new AokanaBpMemory(new Uint8Array(256)),
    context = {thread, memory},
    nameAddress = 32,
    setOutput = 128,
    clearedOutput = 132;
  memory.globalMemory.set(new TextEncoder().encode('flags\0'), nameAddress);
  memory.writeU32(thread, setOutput, 0x11223344);
  memory.writeU32(thread, clearedOutput, 0x55667788);
  assert.equal(slots.length, 4);
  for (const slot of slots)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x80][slot.secondary]);

  const call = (secondary, ...args) => {
    args.forEach((value) => push32(thread, value));
    assert.equal(slots.find((slot) => slot.secondary === secondary).execute(context), 0);
    const result = pop32(thread);
    assert.equal(thread.stackIndex, 0);
    return result;
  };

  assert.equal(call(0x88, nameAddress, 12), 1);
  assert.equal(call(0x89, nameAddress, 9, 7), 0);
  assert.equal(call(0x8a, nameAddress, 1, 1, 6), 0);
  assert.equal(call(0x8a, nameAddress, 3, 0, 2), 0);
  assert.equal(call(0x8b, setOutput, nameAddress, 2), 0);
  assert.equal(call(0x8b, clearedOutput, nameAddress, 3), 0);
  assert.equal(memory.readU32(thread, setOutput), 1);
  assert.equal(memory.readU32(thread, clearedOutput), 0);
  assert.deepEqual(
    bits.snapshots().map(({bitCount, data}) => [bitCount, [...data]]),
    [[12, [0x66, 0x40]]],
  );
});
