import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  nativeMd5,
  updateNativeChecksum,
  group81Hash,
} from '../dist/engines/buriko/native/group-81-hash.js';
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';

test('native MD5 matches independent digests across padding and block boundaries', () => {
  const output = new Uint8Array(16);
  for (let count = 0; count <= 257; count++) {
    const source = Uint8Array.from({length: count}, (_, i) => (i * 149 + count) & 255);
    nativeMd5({bytes: output, offset: 0}, count ? {bytes: source, offset: 0} : null, count);
    assert.equal(
      Buffer.from(output).toString('hex'),
      createHash('md5').update(source).digest('hex'),
    );
  }
});

test('native MD5 snapshots input before writing overlapping output', () => {
  const bytes = Uint8Array.from({length: 256}, (_, i) => i);
  const expected = createHash('md5').update(bytes.subarray(0, 128)).digest();
  nativeMd5({bytes, offset: 2}, {bytes, offset: 0}, 128);
  assert.deepEqual(bytes.subarray(2, 18), new Uint8Array(expected));
});

test('native checksum retains state across chunks and rereads aliased source bytes', () => {
  const full = new Uint8Array(8),
    chunks = new Uint8Array(8),
    source = Uint8Array.from([10, 20, 30, 40]);
  updateNativeChecksum({bytes: full, offset: 0}, {bytes: source, offset: 0}, 4);
  updateNativeChecksum({bytes: chunks, offset: 0}, {bytes: source, offset: 0}, 2);
  updateNativeChecksum({bytes: chunks, offset: 0}, {bytes: source, offset: 2}, 2);
  assert.deepEqual(full, chunks);
  assert.equal(new DataView(full.buffer).getUint32(0, true), 127586180);
  assert.equal(full[6], 100);
  assert.equal(full[7], 40);
  const alias = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  updateNativeChecksum({bytes: alias, offset: 0}, {bytes: alias, offset: 6}, 1);
  assert.equal(alias[6], 14);
  assert.equal(alias[7], 6);
  updateNativeChecksum(null, null, 0);
});

test('81 hash wrappers pop count, source, destination without pushing a value', () => {
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 64,
    frameCapacity: 64,
  });
  const memory = new BurikoBpMemory(new Uint8Array(256));
  memory.globalMemory.set([97, 98, 99], 32);
  for (const value of [64, 32, 3]) push32(thread, value);
  const depth = thread.stackIndex;
  assert.equal(group81Hash[1].execute({thread, memory}), 0);
  assert.equal(thread.stackIndex, (depth - 3) & 15);
  assert.equal(
    Buffer.from(memory.globalMemory.subarray(64, 80)).toString('hex'),
    '900150983cd24fb0d6963f7d28e17f72',
  );
});
