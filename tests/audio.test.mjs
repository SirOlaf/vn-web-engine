import test from 'node:test';
import assert from 'node:assert/strict';
import {BitReader} from '../dist/core/bits.js';
import {BlobSource, SliceSource} from '../dist/core/source.js';
import {hcaCrc, parseHcaHeader} from '../dist/formats/cri/hca/header.js';
import {HcaDecoder} from '../dist/formats/cri/hca/decoder.js';
import {HcaStream} from '../dist/formats/cri/hca/stream.js';
import {HcaImdct} from '../dist/formats/cri/hca/imdct.js';
import {WINDOW} from '../dist/formats/cri/hca/tables.js';
import {encodeWav} from '../dist/audio/pcm.js';
import {CpkArchive} from '../dist/formats/cri/cpk.js';
import {openSource} from '../tools/file-source.mjs';
const data = new URL('../../Data/', import.meta.url);
function crcFix(b) {
  const crc = hcaCrc(b.subarray(0, b.length - 2));
  b[b.length - 2] = crc >>> 8;
  b[b.length - 1] = crc & 255;
  return b;
}
async function asset(name, id, fn) {
  const source = await openSource(new URL(name + '.cpk', data));
  try {
    const archive = await CpkArchive.open(source),
      e = archive.byId.get(id);
    return await fn(new SliceSource(source, e.offset, e.storedSize));
  } finally {
    await source.close();
  }
}
test('MSB bit reader crosses byte boundaries and supports non-consuming peeks', () => {
  const r = new BitReader(Uint8Array.of(0xab, 0xcd, 0xef));
  assert.equal(r.read(4), 10);
  assert.equal(r.peek(8), 0xbc);
  assert.equal(r.position, 4);
  assert.equal(r.read(12), 0xbcd);
  assert.equal(r.read(8), 0xef);
  assert.throws(() => r.read(1));
  assert.equal(r.read(0), 0);
});
test('HCA CRC polynomial has a known check value and detects changed bytes', () => {
  assert.equal(hcaCrc(new TextEncoder().encode('123456789')), 0xfee8);
  const b = crcFix(Uint8Array.of(1, 2, 3, 4, 0, 0));
  assert.equal(hcaCrc(b), 0);
  b[0] ^= 1;
  assert.notEqual(hcaCrc(b), 0);
});
test('HCA header rejects corrupt, truncated and unsupported profiles', async () =>
  asset('voice', 1, async (source) => {
    const raw = await source.read(0, 96),
      h = parseHcaHeader(raw, source.size);
    assert.equal(h.channels, 1);
    assert.equal(h.encoderDelay, 128);
    assert.equal(h.sampleCount, 20 * 1024 - 128 - 403);
    const bad = raw.slice();
    bad[12] ^= 1;
    assert.throws(() => parseHcaHeader(bad), /CRC/);
    assert.throws(() => parseHcaHeader(raw.subarray(0, 95)));
    assert.throws(() => parseHcaHeader(raw, source.size + 1), /payload size/);
    for (const [offset, value, error] of [
      [4, 3, /version/],
      [30, 0, /profile/],
      [36, 1, /profile/],
      [45, 1, /cipher/],
    ]) {
      const b = raw.slice();
      b[offset] = value;
      crcFix(b);
      assert.throws(() => parseHcaHeader(b), error);
    }
    const masked = raw.slice();
    for (const offset of [0, 8, 24, 40, 46]) for (let i = 0; i < 4; i++) masked[offset + i] |= 0x80;
    crcFix(masked);
    assert.equal(parseHcaHeader(masked).sampleCount, h.sampleCount);
  }));
test('embedded loop points are relative to delay-trimmed PCM, with exclusive end', async () =>
  asset('bgm', 0, async (source) => {
    const {header: h} = await HcaStream.open(source);
    assert.deepEqual(h.loop, {
      startBlock: 140,
      endBlock: 2055,
      startDelay: 128,
      endPadding: 1009,
      start: 143105,
      end: 2103952,
    });
    assert.ok(h.loop.end <= h.sampleCount);
  }));
test('bounded sub-source translates ranges without escaping its parent', async () => {
  const src = new SliceSource(new BlobSource(new Blob([Uint8Array.of(0, 1, 2, 3, 4)])), 1, 3);
  assert.deepEqual([...(await src.read(1, 2))], [2, 3]);
  assert.throws(() => new SliceSource(src, 2, 2));
  await assert.rejects(async () => src.read(2, 2));
});
test('IMDCT formula, symmetry, overlap history and reset', () => {
  const transform = new HcaImdct(),
    spectrum = new Float32Array(128),
    first = new Float32Array(128),
    second = new Float32Array(128);
  spectrum[7] = 1;
  transform.process(spectrum, first);
  transform.process(new Float32Array(128), second);
  for (let n = 0; n < 256; n++) {
    const expected =
      Math.cos((Math.PI / 128) * (n + 64.5) * 7.5) * 0.125 * WINDOW[n < 128 ? n : 255 - n];
    assert.ok(Math.abs((n < 128 ? first[n] : second[n - 128]) - expected) < 1e-8);
  }
  transform.reset();
  transform.process(new Float32Array(128), first);
  assert.ok(first.every((x) => x === 0));
});
test('HCA block CRC is checked before decoding; reset recovers from failure', async () =>
  asset('sysse', 0, async (source) => {
    const {header: h} = await HcaStream.open(source),
      b = await source.read(h.headerSize, h.blockSize),
      decoder = new HcaDecoder(h),
      expected = decoder.decodeBlock(b);
    decoder.reset();
    const corrupt = b.slice();
    corrupt[20] ^= 0x80;
    assert.throws(() => decoder.decodeBlock(corrupt), /CRC/);
    assert.throws(() => decoder.decodeBlock(b), /reset/);
    decoder.reset();
    assert.deepEqual(decoder.decodeBlock(b), expected);
    const sync = crcFix(b.slice());
    sync[0] = 0;
    crcFix(sync);
    decoder.reset();
    assert.throws(() => decoder.decodeBlock(sync), /sync/);
  }));
test('PCM stream trims encoder delay/padding without losing channel alignment', async () =>
  asset('sysse', 1, async (source) => {
    const stream = await HcaStream.open(source),
      h = stream.header,
      clip = await stream.decode();
    assert.equal(clip.sampleCount, h.blockCount * 1024 - h.encoderDelay - h.encoderPadding);
    assert.equal(clip.channels.length, 2);
    const decoder = new HcaDecoder(h),
      raw = [[], []];
    for (let i = 0; i < h.blockCount; i++) {
      const pcm = decoder.decodeBlock(
        await source.read(h.headerSize + i * h.blockSize, h.blockSize),
      );
      for (let c = 0; c < 2; c++) raw[c].push(...pcm[c]);
    }
    for (let c = 0; c < 2; c++)
      assert.deepEqual(
        [...clip.channels[c]],
        raw[c].slice(h.encoderDelay, h.blockCount * 1024 - h.encoderPadding),
      );
    await assert.rejects(() => stream.decode({maxPcmBytes: 1}), /memory/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => stream.decode({signal: controller.signal}));
  }));
test('WAV interleaves channels, writes RIFF dimensions, and saturates samples', () => {
  const bytes = encodeWav({
      sampleRate: 48000,
      sampleCount: 3,
      channels: [Float32Array.of(-2, 0, 2), Float32Array.of(1, -1, 0.5)],
    }),
    v = new DataView(bytes.buffer);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'RIFF');
  assert.equal(v.getUint32(4, true), 48);
  assert.equal(v.getUint16(22, true), 2);
  assert.equal(v.getUint32(24, true), 48000);
  assert.equal(v.getUint32(40, true), 12);
  assert.deepEqual(
    Array.from({length: 6}, (_, i) => v.getInt16(44 + i * 2, true)),
    [-32768, 32767, 0, -32768, 32767, 16384],
  );
  assert.throws(
    () => encodeWav({sampleRate: 48000, sampleCount: 1, channels: [Float32Array.of(NaN)]}),
    /Non-finite/,
  );
});
