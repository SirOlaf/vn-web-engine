import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {createGroup80SdcDecode} from '../dist/engines/buriko/native/group-80-sdc-decode.js';

test('80:C1 expands independent literal and overlapping-repeat tokens into actual caller storage', () => {
  const encoded = new Uint8Array(41),
    header = new DataView(encoded.buffer);
  encoded.set(new TextEncoder().encode('SDC FORMAT 1.00\0'));
  header.setUint32(20, 9, true);
  header.setUint32(24, 40, true);
  header.setUint16(28, 1063, true);
  header.setUint16(30, 203, true);
  // Seed0: literal AB, repeat17/distance2, repeat17/distance2, repeat4/distance2.
  encoded.set([1, 155, 196, 222, 66, 128, 205, 75, 15], 32);
  const memory = new BurikoBpMemory(new Uint8Array(0x1000)),
    thread = new BurikoBpThread({id: 1, operandCapacity: 8, moduleCapacity: 64, frameCapacity: 0}),
    [slot] = createGroup80SdcDecode();
  memory.globalMemory.set(encoded, 0x100);
  thread.moduleMemory.fill(0xa5);
  push32(thread, 0x10000008);
  push32(thread, 0x100);
  assert.equal(slot.execute({thread, memory}), 0);
  assert.equal(pop32(thread), 40);
  assert.equal(thread.stackIndex, 0);
  assert.deepEqual(thread.moduleMemory.subarray(8, 48), new TextEncoder().encode('AB'.repeat(20)));
  assert.deepEqual(thread.moduleMemory.subarray(0, 8), new Uint8Array(8).fill(0xa5));
  assert.deepEqual(thread.moduleMemory.subarray(48), new Uint8Array(16).fill(0xa5));
  assert.deepEqual(memory.globalMemory.subarray(0x100, 0x100 + encoded.length), encoded);
});
