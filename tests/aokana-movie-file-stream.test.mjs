import test from 'node:test';
import assert from 'node:assert/strict';
import {SourceFileSystem} from '../dist/platform/filesystem.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaMovieFileStream} from '../dist/engines/buriko/games/aokana/native/movie-file-stream.js';
function setup(source, clock = () => 100) {
  const filesystem = new SourceFileSystem();
  filesystem.attach('/movie', source);
  return new AokanaMovieFileStream(
    new AokanaProgramFiles(filesystem, new AokanaNativeText(), new AokanaProgramMedia()),
    clock,
  );
}
test('custom movie source retains bounded seek/read counts, preload bytes and short-read tails', async () => {
  let calls = 0;
  const stream = setup({
    size: 12,
    async read(offset, count) {
      calls++;
      const all = new Uint8Array([0, 1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
      return calls === 1 ? all.slice(offset, offset + count) : new Uint8Array([90, 91]);
    },
  });
  assert.deepEqual(await stream.read(new Uint8Array(8), 0, 8, {}), {status: 1});
  assert.equal(stream.setPointer(-1n), 1);
  assert.throws(() => stream.size(), /unwritten native region length/);
  assert.equal(await stream.initialize('/movie', 8, 2), 0);
  assert.deepEqual(stream.size(), {total: 8n, available: 8n});
  assert.equal(stream.alignment(), 1);
  const output = new Uint8Array(8);
  assert.deepEqual(await stream.read(output, 0, 6, {}), {status: 0, count: 6});
  assert.deepEqual([...output], [90, 91, 12, 13, 14, 15, 0, 0]);
  assert.equal(stream.currentPosition, 6n);
  assert.equal(stream.setPointer(9n), 1);
  assert.equal(stream.currentPosition, 6n);
  assert.deepEqual(await stream.read(output, 0, 8, {}), {status: 0, count: 2});
  assert.equal(stream.currentPosition, 8n);
  assert.deepEqual(await stream.read(output, -100, 8, {}), {status: 0, count: 0});
  stream.dispose();
  assert.throws(() => stream.alignment(), /released/);
});

test('custom movie source reallocates before EOF clipping and diagnoses newly unwritten tails', async () => {
  let calls = 0;
  const stream = setup({
    size: 10,
    async read(offset, count) {
      calls++;
      return new Uint8Array(calls === 1 ? count : 1).fill(7);
    },
  });
  assert.equal(await stream.initialize('/movie', 10, 0), 0);
  await assert.rejects(stream.read(new Uint8Array(10), 0, 0x20001, {}), /unwritten native scratch/);
  assert.equal(stream.currentPosition, 0n);
  stream.dispose();
});

test('custom movie source initialization preserves failure ordering and does not reset cursor on reuse', async () => {
  const source = {
    size: 0x200000000,
    async read(offset, count) {
      return new Uint8Array(count).fill(3);
    },
  };
  const stream = setup(source);
  assert.equal(await stream.initialize('/movie', 10, 0xffffffff), 1);
  assert.equal(await stream.initialize('/movie', 10, 0), 0);
  assert.equal(stream.setPointer(8n), 0);
  assert.equal(await stream.initialize('/movie', 12, 0), 0);
  assert.equal(stream.currentPosition, 8n);
  assert.equal(await stream.initialize('/missing', 20, 0), 1);
  assert.deepEqual(stream.size(), {total: 12n, available: 12n});
  assert.deepEqual(await stream.read(new Uint8Array(4), 0, 4, {}), {status: 1});
  stream.dispose();
});

test('custom movie stream lock is recursive and transfers ownership in queue order', async () => {
  const stream = setup({
      size: 0,
      async read() {
        return new Uint8Array();
      },
    }),
    a = {},
    b = {},
    order = [];
  await stream.lock(a);
  await stream.lock(a);
  const pending = stream.lock(b).then(() => order.push('b'));
  await Promise.resolve();
  assert.deepEqual(order, []);
  stream.unlock(a);
  await Promise.resolve();
  assert.deepEqual(order, []);
  stream.unlock(a);
  await pending;
  assert.deepEqual(order, ['b']);
  assert.throws(() => stream.unlock(a), /another worker/);
  stream.unlock(b);
  stream.dispose();
});
