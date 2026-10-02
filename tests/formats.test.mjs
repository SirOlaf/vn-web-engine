import test from 'node:test';
import assert from 'node:assert/strict';
import {BinaryReader, ByteView, checkRange, safeNumber} from '../dist/core/binary.js';
import {BlobSource, HttpSource} from '../dist/core/source.js';
import {subscribeSourceActivity} from '../dist/core/source-activity.js';
import {
  getRuntimePerformanceSnapshot,
  startRuntimePerformanceRecording,
  stopRuntimePerformanceRecording,
} from '../dist/platform/runtime-performance.js';
import {parseUtf} from '../dist/formats/cri/utf.js';
import {CpkArchive} from '../dist/formats/cri/cpk.js';
import {decodeCrilayla} from '../dist/formats/cri/crilayla.js';
import {AssetGroup} from '../dist/engines/mages/assets.js';
import {openSource} from '../tools/file-source.mjs';
const data = new URL('../../Data/', import.meta.url);
function compressed(bitString, bodySize) {
  const padded = bitString.padEnd(Math.ceil(bitString.length / 8) * 8, '0');
  const stream = Buffer.from((padded.match(/.{8}/g) ?? []).map((s) => parseInt(s, 2))).reverse();
  const out = Buffer.alloc(16 + stream.length + 256);
  out.write('CRILAYLA');
  out.writeUInt32LE(bodySize, 8);
  out.writeUInt32LE(stream.length, 12);
  stream.copy(out, 16);
  for (let i = 0; i < 256; i++) out[16 + stream.length + i] = i;
  return out;
}
const literal = (n) => '0' + n.toString(2).padStart(8, '0');
const prefix = literal(67) + literal(66) + literal(65);
const backref = '1' + '0'.repeat(13); // distance 3
function encodedLength(length) {
  let rest = length - 3,
    result = '';
  for (const width of [2, 3, 5, 8]) {
    const max = 2 ** width - 1,
      n = Math.min(max, rest);
    result += n.toString(2).padStart(width, '0');
    rest -= n;
    if (n < max) return result;
  }
  while (rest >= 255) {
    result += '1'.repeat(8);
    rest -= 255;
  }
  return result + rest.toString(2).padStart(8, '0');
}
test('binary bounds and 64-bit values retain precision', () => {
  assert.throws(() => checkRange(10, -1, 1));
  assert.throws(() => checkRange(10, 9, 2));
  assert.throws(() => safeNumber(2n ** 53n));
  assert.equal(
    new BinaryReader(Uint8Array.of(255, 255, 255, 255, 255, 255, 255, 255)).u64(),
    2n ** 64n - 1n,
  );
});
test('byte views check every read against their limit and record ends', () => {
  const bytes = Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7, 8);
  const view = new ByteView(bytes.subarray(1), {littleEndian: true, end: 6});
  assert.equal(view.u16(0), 0x0201);
  assert.equal(view.u32(2), 0x06050403);
  assert.throws(() => view.u32(3), RangeError);
  assert.throws(() => view.u16(1, 2), RangeError);
  assert.throws(() => view.u8(0, 7), RangeError);
  assert.equal(new ByteView(bytes).sub(4, 4).u16(0), 0x0405);
  class Custom extends Error {}
  assert.throws(() => new ByteView(bytes, {error: () => new Custom()}).range(8, 2), Custom);
});

test('CRILAYLA literal order and untouched 256-byte prefix', () => {
  const result = decodeCrilayla(compressed(prefix, 3), 259);
  assert.deepEqual(
    [...result.subarray(0, 256)],
    Array.from({length: 256}, (_, i) => i),
  );
  assert.equal(Buffer.from(result.subarray(256)).toString(), 'ABC');
});
for (const length of [3, 5, 6, 12, 13, 43, 44, 298, 299, 554, 809])
  test(`CRILAYLA overlapping match of length ${length}`, () => {
    const result = decodeCrilayla(compressed(prefix + backref + encodedLength(length), length + 3));
    const body = result.subarray(256);
    assert.equal(body.length, length + 3);
    for (let i = 0; i < body.length; i++)
      assert.equal(body[body.length - 1 - i], [67, 66, 65][i % 3]);
  });
test('CRILAYLA rejects truncation, invalid references, overflow and size mismatch', () => {
  const valid = compressed(prefix, 3);
  assert.throws(() => decodeCrilayla(valid.subarray(0, valid.length - 1)));
  assert.throws(() => decodeCrilayla(valid, 999));
  assert.throws(() => decodeCrilayla(valid, undefined, 258));
  assert.throws(() => decodeCrilayla(compressed(backref + '00', 3)), /back-reference/);
  assert.throws(() => decodeCrilayla(compressed(prefix + backref + '10', 6)), /back-reference/);
  assert.throws(() => decodeCrilayla(compressed('', 3)));
});
test('UTF constant/zero/row storage, nested data and malicious offsets', () => {
  const b = Buffer.alloc(91);
  b.write('@UTF');
  b.writeUInt32BE(83, 4);
  b.writeUInt16BE(48, 10);
  b.writeUInt32BE(56, 12);
  b.writeUInt32BE(80, 16);
  b.writeUInt32BE(1, 20);
  b.writeUInt16BE(3, 24);
  b.writeUInt16BE(8, 26);
  b.writeUInt32BE(1, 28);
  b[32] = 0x34;
  b.writeUInt32BE(7, 33);
  b.writeUInt32BE(123, 37);
  b[41] = 0x14;
  b.writeUInt32BE(9, 42);
  b[46] = 0x5b;
  b.writeUInt32BE(11, 47);
  b.writeUInt32BE(0, 56);
  b.writeUInt32BE(3, 60);
  b.write('\0Table\0a\0b\0c\0', 64);
  b.set([1, 2, 3], 88);
  const t = parseUtf(b);
  assert.equal(t.name, 'Table');
  assert.equal(t.rows[0].a, 123);
  assert.equal(t.rows[0].b, 0);
  assert.deepEqual([...t.rows[0].c], [1, 2, 3]);
  const broken = Buffer.from(b);
  broken.writeUInt32BE(0xffffffff, 56);
  assert.throws(() => parseUtf(broken));
  assert.throws(() => parseUtf(b.subarray(0, 90)));
  const badStride = Buffer.from(b);
  badStride.writeUInt16BE(7, 26);
  assert.throws(() => parseUtf(badStride), /row width/);
});
test('real split ITOC: sparse IDs, localized mount precedence, range reading', async () => {
  const a = await openSource(new URL('bg.cpk', data)),
    b = await openSource(new URL('bg_eng.cpk', data));
  try {
    const base = await CpkArchive.open(a),
      localized = await CpkArchive.open(b),
      group = new AssetGroup([base, localized]);
    assert.equal(base.entries.length, 728);
    assert.equal(localized.entries.length, 102);
    assert.equal(localized.byId.has(0), false);
    assert.equal(group.resolve(0).archive, base);
    assert.equal(group.resolve(1).archive, localized);
    assert.equal(Buffer.from(await localized.readStoredRange(1, 8, 4)).toString(), 'WEBP');
    await assert.rejects(() => base.readStoredRange(0, base.byId.get(0).storedSize, 1));
  } finally {
    await a.close();
    await b.close();
  }
});
test('real named TOC and decompressed bytecode are accessible', async () => {
  const a = await openSource(new URL('shader.cpk', data)),
    b = await openSource(new URL('script.cpk', data));
  try {
    const shaders = await CpkArchive.open(a),
      scripts = await CpkArchive.open(b);
    assert.equal(shaders.entries[0].name, 'sh000tlvm_vs');
    assert.equal(Buffer.from(await shaders.readStoredRange(2, 0, 4)).toString(), 'DXBC');
    assert.equal((await scripts.read(0)).length, 17660);
    await assert.rejects(() => scripts.read(65535));
  } finally {
    await a.close();
    await b.close();
  }
});
test('Blob reads only requested ranges; HTTP refuses full-file fallback', async (t) => {
  const blob = new BlobSource(new Blob([Uint8Array.of(1, 2, 3, 4)]));
  assert.deepEqual([...(await blob.read(1, 2))], [2, 3]);
  await assert.rejects(() => blob.read(4, 1));
  t.mock.method(globalThis, 'fetch', async () => new Response('abcd', {status: 200}));
  await assert.rejects(() => new HttpSource('http://test/', 4).read(0, 2), /honor byte ranges/);
});

test('read timings separate local and remote throughput without changing read failure or activity', async (t) => {
  let now = 0,
    localDelay = 1,
    abortLocal = false,
    truncateRemote = false;
  t.mock.method(performance, 'now', () => now);
  const controller = new AbortController(),
    abortReason = new Error('Synthetic read cancellation'),
    data = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8),
    local = new BlobSource({
      size: data.length,
      slice: (start, end) => ({
        arrayBuffer: async () => {
          now += localDelay;
          if (abortLocal) controller.abort(abortReason);
          return data.slice(start, end).buffer;
        },
      }),
    });
  let before;
  subscribeSourceActivity((value) => (before = value))();
  await local.read(0, 1);
  const activity = [],
    unsubscribe = subscribeSourceActivity((value) => activity.push(value));
  assert.equal(activity[0].readBytes - before.readBytes, 1, 'unobserved reads remain cumulative');
  t.after(() => {
    unsubscribe();
    stopRuntimePerformanceRecording();
  });
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.headers.Range, 'bytes=2-4');
    now += 6;
    return new Response(truncateRemote ? data.slice(2, 4) : data.slice(2, 5), {
      status: 206,
      headers: {'Content-Range': 'bytes 2-4/8'},
    });
  });
  const remote = new HttpSource('https://synthetic.invalid/private-archive-name', 8);
  startRuntimePerformanceRecording();
  assert.deepEqual(await local.read(1, 2), data.slice(1, 3));
  localDelay = 5;
  assert.deepEqual(await local.read(0, 4), data.slice(0, 4));
  assert.deepEqual(await remote.read(2, 3), data.slice(2, 5));
  truncateRemote = true;
  await assert.rejects(remote.read(2, 3), /Truncated HTTP range/);
  abortLocal = true;
  await assert.rejects(local.read(0, 2, controller.signal), (error) => error === abortReason);
  await assert.rejects(local.read(0, 1, controller.signal), (error) => error === abortReason);
  await assert.rejects(local.read(9, 1));
  assert.equal((await local.read(8, 0)).length, 0);
  stopRuntimePerformanceRecording();

  const snapshot = getRuntimePerformanceSnapshot(),
    aggregate = (name) => snapshot.aggregates.find((entry) => entry.name === name);
  assert.equal(aggregate('source.local-read').count, 3);
  assert.equal(aggregate('source.remote-read').count, 2);
  assert.equal(aggregate('source.local-read.completed-bytes').total, 6);
  assert.equal(aggregate('source.local-read.completed-bytes').count, 2);
  assert.equal(aggregate('source.remote-read.completed-bytes').total, 3);
  assert.equal(aggregate('source.remote-read.completed-bytes').count, 1);
  assert.deepEqual(
    snapshot.events.filter((event) => event.name === 'source.local-read').map(({detail}) => detail),
    [
      {requestedBytes: 4, completedBytes: 4, success: true},
      {requestedBytes: 2, completedBytes: 0, success: false},
    ],
  );
  assert.deepEqual(
    snapshot.events
      .filter((event) => event.name === 'source.remote-read')
      .map(({detail}) => detail),
    [
      {requestedBytes: 3, completedBytes: 3, success: true},
      {requestedBytes: 3, completedBytes: 0, success: false},
    ],
  );
  assert.equal(JSON.stringify(snapshot).includes('private-archive-name'), false);
  assert.equal(activity.at(-1).pending, 0);
  assert.equal(activity.at(-1).readBytes - before.readBytes, 7);
  assert.equal(activity.at(-1).receivedBytes - before.receivedBytes, 3);
});
