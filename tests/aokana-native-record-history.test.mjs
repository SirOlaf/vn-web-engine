import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {
  AokanaRecordHistories,
  encodeAokanaRecord,
  decodeAokanaRecord,
} from '../dist/engines/buriko/games/aokana/native/record-history.js';
import {createGroup80RecordHistory} from '../dist/engines/buriko/games/aokana/native/group-80-record-history.js';

test('80:98/99/9A/9C–9F retain bounded copied records with exact zero-run and raw modes', async () => {
  const histories = new AokanaRecordHistories(),
    slots = createGroup80RecordHistory(histories),
    memory = new AokanaBpMemory(new Uint8Array(0x1000)),
    thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 4096,
      frameCapacity: 0,
    }),
    bytes = thread.moduleMemory,
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const invoke = async (slot, args) => {
    for (const value of args) push32(thread, value);
    assert.equal(await slots.find((s) => s.secondary === slot).execute({thread, memory}), 0);
    const result = pop32(thread);
    assert.equal(thread.stackIndex, 0);
    return result;
  };
  const first = Uint8Array.of(0, 0, 4, 0, 5, 0, 0, 0, 6, 7, 0, 0, 0, 0, 0, 0),
    second = first.slice(),
    third = first.slice();
  second[2] = 8;
  third[8] = 9;
  const encoded = encodeAokanaRecord(first);
  assert.deepEqual(encoded, Uint8Array.of(16, 2, 3, 4, 0, 5, 3, 2, 6, 7, 6));
  const decoded = new Uint8Array(24).fill(0x55);
  assert.equal(decodeAokanaRecord({bytes: decoded, offset: 0}, encoded), 16);
  assert.deepEqual(decoded.subarray(0, 16), first);
  assert.deepEqual(decoded.subarray(16), new Uint8Array(8).fill(0x55));
  assert.equal(await invoke(0x98, [0x10000010, 2, 16]), 0);
  const id = view.getUint32(16, true);
  assert.equal(id, 1);
  for (const record of [first, second, third]) {
    bytes.set(record, 128);
    assert.equal(await invoke(0x9c, [id, 0x10000080]), 0);
    bytes.fill(0x66, 128, 144);
  }
  assert.equal(await invoke(0x9a, [0x10000020, id]), 0);
  assert.equal(view.getUint32(32, true), 2);
  bytes.fill(0x55, 256, 280);
  assert.equal(await invoke(0x9d, [0x10000100, id, 0]), 0);
  assert.deepEqual(bytes.subarray(256, 272), third);
  assert.deepEqual(bytes.subarray(272, 280), new Uint8Array(8).fill(0x55));
  assert.equal(await invoke(0x9d, [0x10000100, id, 1]), 0);
  assert.deepEqual(bytes.subarray(256, 272), second);
  assert.equal(await invoke(0x9e, [id, 1, 1]), 0);
  assert.equal(await invoke(0x9a, [0x10000020, id]), 0);
  assert.equal(view.getUint32(32, true), 1);
  assert.equal(await invoke(0x9d, [0x10000100, id, 0]), 0);
  assert.deepEqual(bytes.subarray(256, 272), third);
  assert.equal(await invoke(0x99, [id]), 0);
  assert.equal(await invoke(0x98, [0x10000010, 2, 16]), 0);
  const rawId = view.getUint32(16, true);
  assert.equal(rawId, 2);
  assert.equal(await invoke(0x9f, [rawId, 0]), 0);
  bytes.set(first, 128);
  assert.equal(await invoke(0x9c, [rawId, 0x10000080]), 0);
  bytes.fill(0x44, 128, 144);
  assert.equal(await invoke(0x9d, [0x10000100, rawId, 0]), 0);
  assert.deepEqual(bytes.subarray(256, 272), first);
  assert.equal(await invoke(0x99, [rawId]), 0);
});
