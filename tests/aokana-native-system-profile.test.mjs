import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaSystemProfile} from '../dist/engines/buriko/games/aokana/native/system-profile.js';
import {createGroupSystemProfile} from '../dist/engines/buriko/games/aokana/native/group-system-profile.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

const ansi = (text) => Uint8Array.from(text, (character) => character.charCodeAt(0));
function fixture() {
  const calls = [];
  const host = {
    readUserName: () => {
      calls.push('user');
      return Uint8Array.of(0x83, 0x65, 0x83, 0x58, 0x83, 0x67);
    },
    readComputerName: () => {
      calls.push('computer');
      return ansi('TEST-PC');
    },
    readVersion: () => {
      calls.push('version');
      return {major: 6, minor: 1, build: 7601, platform: 2, servicePack: ansi('Service Pack 1')};
    },
    readLegacyPhysicalMemory: () => {
      calls.push('legacy');
      return {total: 8n << 30n, available: 1536n << 20n};
    },
    readPhysicalMemory: () => {
      calls.push('extended');
      return {total: (8n << 30n) + 700n, available: (1536n << 20n) + 333n};
    },
  };
  return {host, calls, profile: new AokanaSystemProfile(host)};
}

test('all five system wrappers use the selected Windows profile and preserve native result order', () => {
  const {profile, calls} = fixture();
  const slots = createGroupSystemProfile(profile);
  assert.equal(slots.length, 5);
  for (const slot of slots)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[slot.primary][slot.secondary]);
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 8,
    moduleCapacity: 256,
    frameCapacity: 0,
  });
  const memory = new AokanaBpMemory(),
    context = {thread, memory};
  const call = (primary, secondary, args = []) => {
    args.forEach((value) => push32(thread, value));
    assert.equal(
      slots
        .find((slot) => slot.primary === primary && slot.secondary === secondary)
        .execute(context),
      0,
    );
  };
  call(0x80, 0x0d);
  assert.equal(pop32(thread), 1536 * 1048576);
  assert.equal(pop32(thread), 0x7fffffff);
  call(0x81, 0x08, [0x10000000]);
  const account = memory.resolve(thread, 0x10000000);
  assert.deepEqual(
    [...account.bytes.subarray(account.offset, account.offset + 7)],
    [0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0],
  );
  call(0x81, 0x09, [0x10000020]);
  const machine = memory.resolve(thread, 0x10000020);
  assert.deepEqual(
    machine.bytes.slice(machine.offset, machine.offset + 8),
    Uint8Array.of(...ansi('TEST-PC'), 0),
  );
  call(0x81, 0x0c, [0x10000040, 0x10000060]);
  assert.deepEqual(
    [0, 4, 8, 12].map((offset) => memory.readU32(thread, 0x10000040 + offset)),
    [6, 1, 7601, 2],
  );
  const servicePack = memory.resolve(thread, 0x10000060);
  assert.deepEqual(
    servicePack.bytes.slice(servicePack.offset, servicePack.offset + 15),
    Uint8Array.of(...ansi('Service Pack 1'), 0),
  );
  call(0x81, 0x0d, [0x10000080, 0x10000084]);
  assert.equal(memory.readU32(thread, 0x10000080), 8192);
  assert.equal(memory.readU32(thread, 0x10000084), 1536);
  assert.deepEqual(calls, ['legacy', 'user', 'computer', 'version', 'extended']);
  assert.equal(thread.stackIndex, 0);
});

test('OS record is cached as a complete148-byte snapshot while memory primitives remain separate', () => {
  const {profile, host, calls} = fixture();
  const first = profile.readVersionRecord();
  assert.equal(first.byteLength, 148);
  const original = first.slice();
  first.fill(0);
  host.readVersion = () => {
    throw new Error('The native cached query must not run twice');
  };
  assert.deepEqual(profile.readVersionRecord(), original);
  assert.equal(new DataView(original.buffer).getUint32(0, true), 148);
  assert.deepEqual([...original.subarray(35)], new Array(113).fill(0));
  assert.deepEqual(profile.readLegacyMemory(), [0x7fffffff, 1536 * 1048576]);
  assert.deepEqual(profile.readMemoryMegabytes(), [8192, 1536]);
  host.readPhysicalMemory = () => ({total: 4n << 30n, available: 512n << 20n});
  assert.deepEqual(profile.readMemoryMegabytes(), [4096, 512]);
  assert.deepEqual(calls, ['version', 'legacy', 'extended']);
});
