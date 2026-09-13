import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpDiagnostics} from '../dist/engines/buriko/games/aokana/native/diagnostics.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {createGroup7f} from '../dist/engines/buriko/games/aokana/native/group-7f.js';
import {sortNativeRecords} from '../dist/engines/buriko/games/aokana/native/record-sort.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

function fixture() {
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 32,
    moduleCapacity: 128,
    frameCapacity: 128,
  });
  const memory = new AokanaBpMemory(new Uint8Array(2048));
  const diagnostics = new AokanaBpDiagnostics(() => {});
  const slots = new Map(
    createGroup7f(new AokanaNativeText()).map((slot) => [slot.secondary, slot]),
  );
  const h = {thread, memory, diagnostics};
  return {
    ...h,
    slots,
    run(secondary, values) {
      for (const value of values) push32(thread, value);
      assert.equal(slots.get(secondary).execute(h), 0);
      return pop32(thread);
    },
  };
}

test('7F installs exactly the twelve verified native addresses', () => {
  const h = fixture();
  assert.equal(h.slots.size, 12);
  for (const [secondary, address] of Object.entries(AOKANA_NATIVE_SLOT_ADDRESSES[0x7f])) {
    assert.equal(h.slots.get(Number(secondary)).nativeAddress, address);
  }
});

test('record sort retains native validation precedence and signed width comparisons', () => {
  assert.equal(sortNativeRecords(null, 1, 0, 0, 99), 1);
  assert.equal(sortNativeRecords(null, 2, 0, 0, 99), 3);
  assert.equal(sortNativeRecords(null, 2, 1, 0, 4), 2);
  assert.throws(() => sortNativeRecords(null, 2, 1, 0, 0), /invalid parameter/);
  const bytes = new Uint8Array(32),
    pointer = {bytes, offset: 0},
    view = new DataView(bytes.buffer);
  for (let selector = 0; selector < 6; selector++) {
    const width = 1 << (selector >>> 1);
    const input = [3, -4, 2, -1];
    for (let i = 0; i < input.length; i++) {
      if (width === 1) view.setInt8(i * 8, input[i]);
      else if (width === 2) view.setInt16(i * 8, input[i], true);
      else view.setInt32(i * 8, input[i], true);
      view.setUint32(i * 8 + 4, i, true);
    }
    assert.equal(sortNativeRecords(pointer, 4, 8, 0, selector), 0);
    const ids = [0, 1, 2, 3].map((i) => view.getUint32(i * 8 + 4, true));
    assert.deepEqual(ids, selector & 1 ? [0, 2, 3, 1] : [1, 3, 2, 0]);
  }
  view.setInt32(0, -2147483648, true);
  view.setInt32(8, 2147483647, true);
  sortNativeRecords(pointer, 2, 8, 0, 4);
  assert.equal(view.getInt32(0, true), 2147483647);
});

test('CRT equal-key permutations differ across its eight-record cutoff', () => {
  for (const count of [8, 9, 31]) {
    const bytes = new Uint8Array(count * 8),
      view = new DataView(bytes.buffer);
    for (let i = 0; i < count; i++) view.setUint32(i * 8 + 4, i, true);
    sortNativeRecords({bytes, offset: 0}, count, 8, 0, 4);
    const ids = Array.from({length: count}, (_, i) => view.getUint32(i * 8 + 4, true));
    assert.deepEqual(
      ids,
      count === 8 ? [1, 2, 3, 4, 5, 6, 7, 0] : Array.from({length: count}, (_, i) => i),
    );
  }
});

test('CRT partitioning sorts varied sizes and preserves each complete record', () => {
  let seed = 0x91827364;
  for (let count = 2; count <= 180; count++) {
    const bytes = new Uint8Array(count * 8),
      view = new DataView(bytes.buffer),
      keys = [];
    for (let i = 0; i < count; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      keys.push((seed % 21) - 10);
      view.setInt32(i * 8, keys[i], true);
      view.setUint32(i * 8 + 4, i, true);
    }
    sortNativeRecords({bytes, offset: 0}, count, 8, 0, 4);
    let previous = -Infinity;
    const seen = new Set();
    for (let i = 0; i < count; i++) {
      const key = view.getInt32(i * 8, true),
        id = view.getUint32(i * 8 + 4, true);
      assert.ok(key >= previous);
      assert.equal(key, keys[id]);
      seen.add(id);
      previous = key;
    }
    assert.equal(seen.size, count);
  }
});

test('buffer wrappers preserve argument order, aliases, resizing and native statuses', () => {
  const h = fixture();
  assert.equal(h.run(0x80, [32, 4]), 0);
  const handle = h.memory.readU32(h.thread, 32);
  assert.equal(h.run(0x83, [handle]), 4);
  h.memory.globalMemory.set([1, 2, 3, 4], 64);
  assert.equal(h.run(0x84, [handle, 0, 64, 4]), 0);
  assert.equal(h.run(0x85, [72, handle, 1, 3]), 0);
  assert.deepEqual([...h.memory.globalMemory.subarray(72, 75)], [2, 3, 4]);
  assert.equal(h.run(0x86, [handle, -1, handle, 2]), 0);
  assert.equal(h.run(0x85, [72, handle, 0, 6]), 0);
  assert.deepEqual([...h.memory.globalMemory.subarray(72, 78)], [1, 2, 3, 4, 1, 2]);
  assert.equal(h.run(0x82, [handle, 3]), 0);
  assert.equal(h.run(0x83, [handle]), 3);
  assert.equal(h.run(0x85, [0, handle, 3, 0]), 2);
  assert.equal(h.run(0x85, [0, handle, 0, 0]), 0);
  assert.equal(h.run(0x84, [handle, 2, 0, 2]), 3);
  assert.equal(h.run(0x84, [123, 0, 0, 1]), 1);
  assert.equal(h.run(0x82, [123, 0x40000001]), 3);
  assert.equal(h.run(0x81, [handle]), 0);
  assert.equal(h.run(0x81, [handle]), 1);
  assert.equal(h.run(0x83, [handle]), 0xffffffff);
});

test('string wrappers preserve handle banks and skip formatting on invalid insertion', () => {
  const h = fixture();
  h.memory.globalMemory.set([65, 66, 67, 0], 64);
  assert.equal(h.run(0x88, [32, 64]), 0);
  const handle = h.memory.readU32(h.thread, 32);
  assert.deepEqual([...h.memory.readCString(h.thread, handle)], [65, 66, 67]);
  assert.equal(h.run(0x81, [handle]), 1);
  assert.equal(h.run(0x83, [handle]), 0xffffffff);
  assert.equal(h.run(0x8a, [456, 0, 0]), 1);
  assert.equal(h.run(0x8a, [handle, 4, 0]), 2);
  assert.equal(h.run(0x8b, [handle, 0]), 0);
  assert.equal(h.memory.readCString(h.thread, handle).length, 0);
  assert.equal(h.run(0x89, [handle]), 0);
  assert.equal(h.run(0x89, [handle]), 1);
  assert.equal(h.run(0x88, [32, 0]), 0);
  assert.equal(h.memory.readCString(h.thread, h.memory.readU32(h.thread, 32)).length, 0);
});

test('buffer and string table exhaustion returns four without dereferencing destinations', () => {
  const h = fixture();
  for (let i = 0; i < 256; i++) assert.equal(h.run(0x80, [32, 0]), 0);
  assert.equal(h.run(0x80, [0, 0]), 4);
  for (let i = 0; i < 256; i++) assert.equal(h.run(0x88, [32, 0]), 0);
  assert.equal(h.run(0x88, [0, 0]), 4);
});

test('formatted string insertion consumes arguments in native order and replacement clears first', () => {
  const h = fixture();
  h.memory.globalMemory.set(new TextEncoder().encode('A%d:%sZ\0'), 64);
  h.memory.globalMemory.set(new TextEncoder().encode('hi\0'), 96);
  assert.equal(h.run(0x88, [32, 96]), 0);
  const handle = h.memory.readU32(h.thread, 32);
  assert.equal(h.run(0x8a, [96, 12, handle, 1, 64]), 0);
  assert.equal(new TextDecoder().decode(h.memory.readCString(h.thread, handle)), 'hA12:hiZi');
  assert.equal(h.run(0x8b, [96, 34, handle, 64]), 0);
  assert.equal(new TextDecoder().decode(h.memory.readCString(h.thread, handle)), 'A34:hiZ');
  h.memory.globalMemory.set(new TextEncoder().encode('%cignored\0'), 64);
  assert.equal(h.run(0x8b, [0, handle, 64]), 0);
  assert.equal(h.memory.readCString(h.thread, handle).length, 0);
});
