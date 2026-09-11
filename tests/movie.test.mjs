import test from 'node:test';
import assert from 'node:assert/strict';
import {BitReader} from '../dist/core/bits.js';
import {Vlc} from '../dist/core/vlc.js';
import {Mpeg1Decoder} from '../dist/formats/mpeg1/decoder.js';
import {DC_Y, DC_C} from '../dist/formats/mpeg1/tables.js';
import {UsmReader} from '../dist/formats/cri/usm.js';
import {CriMovie} from '../dist/formats/cri/movie.js';
import {BlobSource, SliceSource} from '../dist/core/source.js';
import {openSource} from '../tools/file-source.mjs';
import {CpkArchive} from '../dist/formats/cri/cpk.js';
const binary = (v, n) => v.toString(2).padStart(n, '0');
const bits = (s) =>
  Uint8Array.from((s + '0'.repeat((8 - (s.length % 8)) % 8)).match(/.{8}/g) ?? [], (b) =>
    parseInt(b, 2),
  );
const section = (code, body) =>
  Buffer.concat([Buffer.from([0, 0, 1, code]), typeof body === 'string' ? bits(body) : body]);
const sequence = () =>
  section(
    0xb3,
    binary(16, 12) + binary(16, 12) + '0001' + '0011' + '0'.repeat(18) + '1' + '0'.repeat(13),
  );
const picture = (type, time) =>
  section(
    0,
    binary(time, 10) +
      binary(type, 3) +
      '1'.repeat(16) +
      (type >= 2 ? '0001' : '') +
      (type === 3 ? '0001' : '') +
      '0',
  );
function intra(type, time, values, precision = 0) {
  let pred = [128 << precision, 128 << precision, 128 << precision],
    s = '00001' + '0' + '1' + (type === 1 ? '1' : '00011');
  for (let b = 0; b < 6; b++) {
    const c = b < 4 ? 0 : b - 3,
      value = (b < 4 ? values[b] : 128) << precision,
      delta = value - pred[c];
    pred[c] = value;
    const n = delta ? Math.floor(Math.log2(Math.abs(delta))) + 1 : 0,
      code = (c ? DC_C : DC_Y).find((x) => x[1] === n)[0];
    s += code + (n ? binary(delta < 0 ? delta + (1 << n) - 1 : delta, n) : '') + '10';
  }
  return Buffer.concat([picture(type, time), section(1, s)]);
}
function decode(data, chunkSize = data.length) {
  const d = new Mpeg1Decoder(),
    out = [];
  for (let i = 0; i < data.length; i += chunkSize)
    out.push(...d.push(data.subarray(i, i + chunkSize)));
  out.push(...d.flush());
  return out;
}
test('VLC validates prefix codes and fails on truncated/invalid codewords', () => {
  const v = new Vlc([
    ['1', 7],
    ['01', -2],
  ]);
  assert.equal(v.read(new BitReader(bits('01'), 2)), -2);
  assert.throws(() => v.read(new BitReader(bits('0'), 1)));
  assert.throws(
    () =>
      new Vlc([
        ['1', 0],
        ['10', 1],
      ]),
  );
  assert.throws(() => v.read(new BitReader(bits('00'), 2)));
});
test('MPEG I/P/B references reorder into display order, including final delayed reference', () => {
  const data = Buffer.concat([
    sequence(),
    intra(1, 0, [50, 50, 50, 50]),
    intra(2, 2, [150, 150, 150, 150]),
    picture(3, 1),
    section(1, '00001' + '0' + '1' + '10' + '1111'),
    section(0xb7, ''),
  ]);
  for (const chunk of [1, 7, data.length]) {
    const f = decode(data, chunk);
    assert.deepEqual(
      f.map((x) => x.y[0]),
      [50, 100, 150],
    );
    assert.deepEqual(
      f.map((x) => x.temporalReference),
      [0, 1, 2],
    );
    assert.deepEqual(
      f.map((x) => x.index),
      [0, 1, 2],
    );
    assert.ok(f.every((x) => x.cb[0] === 128 && x.cr[0] === 128));
  }
});
test('MPEG half-pel prediction rounds and samples across block boundaries', () => {
  const data = Buffer.concat([
    sequence(),
    intra(1, 0, [50, 150, 50, 150]),
    picture(2, 1),
    section(1, '00001' + '0' + '1' + '001' + '010' + '1'),
    section(0xb7, ''),
  ]);
  const f = decode(data);
  assert.equal(f[1].y[6], 50);
  assert.equal(f[1].y[7], 100);
  assert.equal(f[1].y[8], 150);
  assert.equal(f[1].y[15], 150);
});
test('CRI IDCPREC selects 11-bit DC prediction/scaling', () => {
  const data = Buffer.concat([
    sequence(),
    section(0xb2, Buffer.from('TMPGEXS\0' + '00000028' + 'IDCPREC\0' + '00000008' + '00000003')),
    intra(1, 0, [50, 100, 150, 200], 3),
    section(0xb7, ''),
  ]);
  const f = decode(data)[0];
  assert.deepEqual([f.y[0], f.y[8], f.y[128], f.y[136]], [50, 100, 150, 200]);
});
test('MPEG rejects incomplete pictures and truncated VLC payloads', () => {
  assert.throws(
    () => decode(Buffer.concat([sequence(), picture(1, 0), section(0xb7, '')])),
    /Incomplete/,
  );
  assert.throws(
    () => decode(Buffer.concat([sequence(), picture(1, 0), section(1, '00001011')])),
    /slice/,
  );
  const d = new Mpeg1Decoder();
  assert.throws(() => d.push(Uint8Array.of(0, 0, 1, 0xb5, 0, 0, 1, 0xb7)), /Unsupported/);
  assert.throws(() => d.flush(), /closed/);
});
test('USM rejects invalid offsets, padding, truncated packets, encryption, and unknown stream tags', async () => {
  const packet = Buffer.alloc(32);
  packet.write('CRID');
  packet.writeUInt32BE(24, 4);
  packet[9] = 24;
  packet[15] = 1;
  const open = (b) => new UsmReader(new BlobSource(new Blob([b])));
  assert.equal((await open(packet).next()).payload.length, 0);
  for (const mutate of [
    (b) => (b[9] = 23),
    (b) => (b[11] = 1),
    (b) => (b[15] = 0x10),
    (b) => b.writeUInt32BE(100, 4),
    (b) => b.write('JUNK'),
  ]) {
    const bad = Buffer.from(packet);
    mutate(bad);
    await assert.rejects(open(bad).next());
  }
  await assert.rejects(open(packet.subarray(0, 31)).next());
});
test('Real CRI movie demuxes, decodes and trims both elementary streams to metadata counts', async () => {
  const source = await openSource(new URL('../../Data/movie.cpk', import.meta.url));
  try {
    const archive = await CpkArchive.open(source),
      e = archive.byId.get(0),
      movie = new CriMovie(new SliceSource(source, e.offset, e.storedSize));
    let frames = 0,
      samples = 0;
    for (;;) {
      const batch = await movie.next();
      for (const f of batch.frames) assert.equal(f.index, frames++);
      for (const a of batch.audio) {
        assert.equal(a.start, samples);
        samples += a.channels[0].length;
      }
      if (batch.done) break;
    }
    assert.equal(frames, 24);
    assert.equal(samples, 38438);
    assert.equal(movie.info.frameCount, frames);
    assert.equal(movie.info.sampleCount, samples);
    await assert.rejects(movie.next(), /ended/);
  } finally {
    await source.close();
  }
});
