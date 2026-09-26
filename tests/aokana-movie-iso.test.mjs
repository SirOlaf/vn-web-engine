import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readBurikoIsoMovie,
  burikoIsoSampleBytes,
  BurikoIsoSampleError,
} from '../dist/engines/buriko/native/movie-iso-samples.js';
import {
  burikoIsoAvcConfiguration,
  burikoIsoAacConfiguration,
} from '../dist/engines/buriko/native/movie-iso-codecs.js';

const join = (...parts) => {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    result.set(part, at);
    at += part.length;
  }
  return result;
};
const u32 = (...values) => {
  const bytes = new Uint8Array(values.length * 4),
    view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value));
  return bytes;
};
const u64 = (...values) => {
  const bytes = new Uint8Array(values.length * 8),
    view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setBigUint64(index * 8, BigInt.asUintN(64, BigInt(value))));
  return bytes;
};
const four = (text) => Uint8Array.from(text, (char) => char.charCodeAt(0));
const box = (type, ...parts) => {
  const body = join(...parts);
  return join(u32(body.length + 8), four(type), body);
};
const full = (type, flags, ...parts) => box(type, u32(flags), ...parts);
const table = (type, rows, stride) => full(type, 0, u32(rows.length / stride), u32(...rows));
const description = box(
  'avc1',
  new Uint8Array(6),
  new Uint8Array([0, 1]),
  new Uint8Array(70),
  box('avcC', new Uint8Array([1, 100, 0, 31, 255, 224, 0])),
);
const empty = () =>
  join(
    table('stts', [], 2),
    table('stsc', [], 3),
    full('stsz', 0, u32(0, 0)),
    table('stco', [], 1),
  );
function track(tables, {id = 1, edits, external = false} = {}) {
  const tkhd = new Uint8Array(80),
    header = new DataView(tkhd.buffer);
  header.setUint32(8, id);
  header.setUint32(16, 300);
  header.setUint32(36, 0x10000);
  header.setUint32(52, 0x10000);
  header.setUint32(68, 0x40000000);
  header.setUint32(72, 1920 * 65536);
  header.setUint32(76, 1080 * 65536);
  return box(
    'trak',
    full('tkhd', 1, tkhd),
    edits ?? new Uint8Array(),
    box(
      'mdia',
      full('mdhd', 0, u32(0, 0, 1000, 300)),
      full('hdlr', 0, u32(0), four('vide')),
      box(
        'minf',
        box('dinf', full('dref', 0, u32(1), full('url ', external ? 0 : 1))),
        box('stbl', full('stsd', 0, u32(1), description), tables),
      ),
    ),
  );
}
const movieHeader = (...children) =>
  box('moov', full('mvhd', 0, u32(0, 0, 1000, 300)), ...children);

test('ISO ordinary sample extraction preserves decode order, signed composition offsets, chunks and edits', () => {
  const media = box('mdat', new Uint8Array([10, 11, 12, 13, 14, 15, 16]));
  const tables = join(
    table('stts', [2, 40, 1, 60], 2),
    full('ctts', 0x1000000, u32(3, 1, 80, 1, -40, 1, 0)),
    table('stsc', [1, 2, 1, 2, 1, 1], 3),
    full('stsz', 0, u32(0, 3, 2, 3, 2)),
    table('stco', [8, 13], 1),
    table('stss', [1, 3], 1),
    full('sdtp', 0, new Uint8Array([0x20, 0x10, 0x20])),
  );
  const edits = box(
    'edts',
    full(
      'elst',
      0x1000000,
      u32(3),
      u64(10, -1),
      u32(65536),
      u64(70, 40),
      u32(65536),
      u64(20, 120),
      u32(0),
    ),
  );
  const movie = readBurikoIsoMovie(join(media, movieHeader(track(tables, {edits}))));
  const video = movie.tracks[0];
  assert.deepEqual(
    video.samples.map(({decodeTime, compositionTime, duration, sync, flags}) => [
      decodeTime,
      compositionTime,
      duration,
      sync,
      flags,
    ]),
    [
      [0n, 80n, 40, true, 0x02000000],
      [40n, 0n, 40, false, 0x01010000],
      [80n, 80n, 60, true, 0x02000000],
    ],
  );
  assert.deepEqual(
    video.samples.map((sample) => [...burikoIsoSampleBytes(movie, video, sample)]),
    [
      [10, 11],
      [12, 13, 14],
      [15, 16],
    ],
  );
  assert.deepEqual(
    video.edits.map(({duration, mediaTime, rate}) => [duration, mediaTime, rate]),
    [
      [10n, -1n, 65536],
      [70n, 40n, 65536],
      [20n, 120n, 0],
    ],
  );
  assert.equal(video.width, 1920 * 65536);
  assert.equal(video.height, 1080 * 65536);
});

test('ISO compact sample sizes cover packed nibbles, bytes and words with 64-bit offsets', () => {
  for (const bits of [4, 8, 16]) {
    const packed =
      bits === 4
        ? new Uint8Array([0x12, 0x30])
        : bits === 8
          ? new Uint8Array([1, 2, 3])
          : new Uint8Array([0, 1, 0, 2, 0, 3]);
    const tables = join(
      table('stts', [3, 1], 2),
      table('stsc', [1, 3, 1], 3),
      full('stz2', 0, u32(bits, 3), packed),
      full('co64', 0, u32(1), u64(0x100000000n)),
    );
    const movie = readBurikoIsoMovie(movieHeader(track(tables)));
    assert.deepEqual(
      movie.tracks[0].samples.map(({offset, size}) => [offset, size]),
      [
        [0x100000000n, 1],
        [0x100000001n, 2],
        [0x100000003n, 3],
      ],
    );
    assert.throws(
      () => burikoIsoSampleBytes(movie, movie.tracks[0], movie.tracks[0].samples[0]),
      /beyond the encoded file/,
    );
  }
});

test('ISO fragments retain defaults, explicit base offsets, signed trun offsets and decode-time discontinuities', () => {
  const defaults = box(
    'mvex',
    full('trex', 0, u32(1, 1, 40, 2, 0x10000)),
    full('trex', 0, u32(2, 1, 20, 1, 0)),
  );
  const moov = movieHeader(track(empty()), track(empty(), {id: 2}), defaults);
  const first = box(
    'moof',
    box(
      'traf',
      full('tfhd', 0x20000, u32(1)),
      full('tfdt', 0x1000000, u64(0x100000000n)),
      full('trun', 0x1000805, u32(2, 200, 0), u32(-20, 5)),
      full('trun', 0, u32(1)),
    ),
    box('traf', full('tfhd', 0, u32(2)), full('trun', 0, u32(2))),
  );
  const second = box(
    'moof',
    box(
      'traf',
      full('tfhd', 0x39, u32(1), u64(500), u32(30, 3, 0)),
      full('tfdt', 0, u32(10)),
      full('trun', 0x701, u32(1, -3, 50, 4, 0x10000)),
    ),
  );
  const movie = readBurikoIsoMovie(join(moov, first, second));
  const video = movie.tracks[0],
    base = BigInt(moov.length + 200);
  assert.deepEqual(
    video.samples.map(({offset, size, decodeTime, compositionTime, duration, sync}) => [
      offset,
      size,
      decodeTime,
      compositionTime,
      duration,
      sync,
    ]),
    [
      [base, 2, 0x100000000n, 0xffffffecn, 40, true],
      [base + 2n, 2, 0x100000028n, 0x10000002dn, 40, false],
      [base + 4n, 2, 0x100000050n, 0x100000050n, 40, false],
      [497n, 4, 10n, 10n, 50, false],
    ],
  );
  assert.deepEqual(
    movie.tracks[1].samples.map(({offset}) => offset),
    [base + 6n, base + 7n],
  );
});

test('ISO external references remain explicit and malformed timing/sample mappings fail', () => {
  const tables = join(
    table('stts', [1, 1], 2),
    table('stsc', [1, 1, 1], 3),
    full('stsz', 0, u32(1, 1)),
    table('stco', [0], 1),
  );
  const movie = readBurikoIsoMovie(movieHeader(track(tables, {external: true})));
  assert.throws(
    () => burikoIsoSampleBytes(movie, movie.tracks[0], movie.tracks[0].samples[0]),
    /external/,
  );
  const extra = join(
    table('stts', [2, 1], 2),
    table('stsc', [1, 1, 1], 3),
    full('stsz', 0, u32(1, 1)),
    table('stco', [0], 1),
  );
  assert.throws(() => readBurikoIsoMovie(movieHeader(track(extra))), /extra samples/);
  assert.throws(
    () => readBurikoIsoMovie(new Uint8Array([0, 0, 0, 1, 109, 111, 111, 118])),
    BurikoIsoSampleError,
  );
});

test('AVC configuration preserves the raw decoder record and exact reduced pixel aspect ratio', () => {
  const header = new Uint8Array(78),
    view = new DataView(header.buffer);
  view.setUint16(24, 1920);
  view.setUint16(26, 1080);
  const bytes = box(
    'avc3',
    header,
    box('avcC', new Uint8Array([1, 100, 16, 40, 255, 224, 0])),
    box('pasp', u32(4, 3)),
  );
  const config = burikoIsoAvcConfiguration({type: 'avc3', headerSize: 8, dataReference: 1, bytes});
  assert.equal(config.codec, 'avc3.641028');
  assert.equal(config.codedWidth, 1920);
  assert.equal(config.codedHeight, 1080);
  assert.equal(config.displayAspectWidth, 64);
  assert.equal(config.displayAspectHeight, 27);
  assert.deepEqual([...config.description], [1, 100, 16, 40, 255, 224, 0]);
});

test('AAC ES descriptors retain optional dependency, URL, OCR and escaped object types', () => {
  const descriptor = (tag, body) =>
    join(new Uint8Array([tag, 0x80, 0x80, 0x80, body.length]), body);
  for (const version of [0, 1, 2]) {
    const header = new Uint8Array(version === 0 ? 28 : version === 1 ? 44 : 64),
      view = new DataView(header.buffer);
    view.setUint16(8, version);
    view.setUint16(16, 2);
    view.setUint32(24, 48000 * 65536);
    if (version === 2) {
      view.setFloat64(32, 96000);
      view.setUint32(40, 6);
    }
    const asc = version === 2 ? new Uint8Array([0xf9, 0x40]) : new Uint8Array([0x11, 0x90]);
    const decoder = descriptor(
      4,
      join(new Uint8Array([0x40, 0x15]), new Uint8Array(11), descriptor(5, asc)),
    );
    const stream = descriptor(
      3,
      join(new Uint8Array([0, 1, 0xe0, 0, 2, 3, 97, 98, 99, 0, 3]), decoder),
    );
    const esds = full('esds', 0, stream),
      bytes = box('mp4a', header, version === 1 ? box('wave', esds) : esds);
    const config = burikoIsoAacConfiguration({
      type: 'mp4a',
      headerSize: 8,
      dataReference: 1,
      bytes,
    });
    assert.equal(config.codec, version === 2 ? 'mp4a.40.42' : 'mp4a.40.2');
    assert.equal(config.sampleRate, version === 2 ? 96000 : 48000);
    assert.equal(config.numberOfChannels, version === 2 ? 6 : 2);
    assert.deepEqual(config.description, asc);
  }
});
