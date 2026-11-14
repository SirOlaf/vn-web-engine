import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {AsfDemuxer, AsfPrerollQueue, readAsfLayout} from '../dist/formats/asf/demux.js';
import {WindowsMediaDecoder} from '../dist/video/windows-media.js';
import {openMovieStream} from '../dist/video/movie.js';

/** Little-endian GUID bytes for the canonical text form. */
function guid(text) {
  const bytes = Buffer.from(text.replace(/-/g, ''), 'hex');
  bytes.subarray(0, 4).reverse();
  bytes.subarray(4, 6).reverse();
  bytes.subarray(6, 8).reverse();
  return bytes;
}
const object = (id, body) => {
  const head = Buffer.alloc(24);
  guid(id).copy(head);
  head.writeBigUInt64LE(BigInt(24 + body.length), 16);
  return Buffer.concat([head, body]);
};
const PACKET = 64;

/** ASF header with an audio stream (1), a video stream (2) whose Stream Properties Object
 * sits inside an Extended Stream Properties Object of the Header Extension, a 64-byte packet
 * size and 3000 ms preroll, followed by the Data Object header and `packets`. */
function asf(packets) {
  const properties = Buffer.alloc(80);
  properties.writeBigUInt64LE(BigInt((3000 + 1000) * 10000), 40);
  properties.writeBigUInt64LE(3000n, 56);
  properties.writeUInt32LE(2, 64);
  properties.writeUInt32LE(PACKET, 68);
  properties.writeUInt32LE(PACKET, 72);
  const stream = (type, number, data) => {
    const body = Buffer.alloc(54);
    guid(type).copy(body);
    body.writeUInt32LE(data.length, 40);
    body.writeUInt16LE(number, 48);
    return object('B7DC0791-A9B7-11CF-8EE6-00C00C205365', Buffer.concat([body, data]));
  };
  const wave = Buffer.alloc(20);
  wave.writeUInt16LE(0x161, 0);
  wave.writeUInt16LE(2, 2);
  wave.writeUInt32LE(44100, 4);
  wave.writeUInt32LE(8000, 8);
  wave.writeUInt16LE(2048, 12);
  wave.writeUInt16LE(16, 14);
  wave.writeUInt16LE(2, 16);
  wave.writeUInt16LE(0xabcd, 18);
  const video = Buffer.alloc(11 + 41);
  video.writeUInt16LE(41, 9);
  video.writeInt32LE(320, 15);
  video.writeInt32LE(-240, 19);
  video.write('WMV3', 27, 'latin1');
  video[51] = 0x4f;
  const extended = Buffer.alloc(64);
  extended.writeUInt16LE(2, 48);
  extended.writeBigUInt64LE(333667n, 52);
  const extension = Buffer.concat([
    Buffer.alloc(22),
    object(
      '14E6A5CB-C672-4332-8399-A96952065B5A',
      Buffer.concat([extended, stream('BC19EFC0-5B4D-11CF-A8FD-00805F5C442B', 2, video)]),
    ),
  ]);
  extension.writeUInt32LE(extension.length - 22, 18);
  const children = [
    object('8CABDCA1-A947-11CF-8EE4-00C00C205365', properties),
    stream('F8699E40-5B4D-11CF-A8FD-00805F5C442B', 1, wave),
    object('5FBF03B5-A92E-11CF-8EE3-00C00C205365', extension),
  ];
  const head = Buffer.alloc(30);
  guid('75B22630-668E-11CF-A6D9-00AA0062CE6C').copy(head);
  const body = Buffer.concat(children);
  head.writeBigUInt64LE(BigInt(30 + body.length), 16);
  head.writeUInt32LE(children.length, 24);
  const data = Buffer.alloc(50);
  guid('75B22636-668E-11CF-A6D9-00AA0062CE6C').copy(data);
  data.writeBigUInt64LE(BigInt(packets.length), 40);
  return new Uint8Array(Buffer.concat([head, body, data, ...packets]));
}

/** A data packet without error correction: byte padding length; byte replicated data
 * length, dword offset and byte object number per payload; byte payload lengths with
 * multiple payloads. Padded to the packet size. */
function packet(payloads, {multiple = payloads.length > 1, compressed = false} = {}) {
  const header = Buffer.from([(multiple ? 1 : 0) | (1 << 3), 0x5d, 0, 0, 0, 0, 0, 0, 0]);
  const body = [];
  if (multiple) body.push(Buffer.from([0x40 | payloads.length]));
  for (const p of payloads) {
    const replicated = compressed ? Buffer.from([1]) : Buffer.alloc(8);
    if (!compressed) {
      replicated.writeUInt32LE(p.size, 0);
      replicated.writeUInt32LE(p.time, 4);
    }
    const offset = Buffer.alloc(4);
    offset.writeUInt32LE(compressed ? p.time : p.offset);
    body.push(
      Buffer.from([p.stream | (p.key ? 0x80 : 0), p.object]),
      offset,
      Buffer.from([replicated.length]),
      compressed ? Buffer.from([0]) : replicated,
    );
    const data = compressed
      ? Buffer.concat(p.objects.flatMap((o) => [Buffer.from([o.length]), Buffer.from(o)]))
      : Buffer.from(p.data);
    if (multiple) body.push(Buffer.from([data.length]));
    body.push(data);
  }
  const used = header.length + body.reduce((n, b) => n + b.length, 0);
  const padding = PACKET - used;
  assert.ok(padding >= 0);
  header[2] = padding;
  return Buffer.concat([header, ...body, Buffer.alloc(padding)]);
}

test('ASF layout lists audio and header-extension video streams with their codec data', () => {
  const layout = readAsfLayout(asf([]));
  assert.equal(layout.packetSize, PACKET);
  assert.equal(layout.duration, 1000);
  assert.equal(layout.dataOffset, layout.headerSize + 50);
  const [audio, video] = layout.streams;
  assert.deepEqual(
    {...audio, extra: [...audio.extra]},
    {
      kind: 'audio',
      number: 1,
      codec: 0x161,
      channels: 2,
      sampleRate: 44100,
      bytesPerSecond: 8000,
      blockAlign: 2048,
      bitsPerSample: 16,
      extra: [0xcd, 0xab],
    },
  );
  assert.deepEqual(
    {...video, extra: [...video.extra]},
    {
      kind: 'video',
      number: 2,
      codec: 0x33564d57,
      width: 320,
      height: 240,
      extra: [0x4f],
      frameTime: 333667,
    },
  );
});

test('ASF demuxer reassembles media objects across packets and payload layouts', () => {
  const layout = readAsfLayout(asf([]));
  const demuxer = new AsfDemuxer(layout);
  const big = Array.from({length: 40}, (_, i) => i);
  // One object split over two single-payload packets.
  assert.deepEqual(
    demuxer.packet(
      packet([
        {stream: 2, key: true, object: 7, offset: 0, size: 40, time: 3033, data: big.slice(0, 30)},
      ]),
    ),
    [],
  );
  const [whole] = demuxer.packet(
    packet([{stream: 2, object: 7, offset: 30, size: 40, time: 3033, data: big.slice(30)}]),
  );
  assert.deepEqual({...whole, data: [...whole.data]}, {stream: 2, time: 33, key: true, data: big});
  // Two complete objects of different streams in one multiple-payload packet.
  const objects = demuxer.packet(
    packet([
      {stream: 1, object: 1, offset: 0, size: 3, time: 3000, data: [1, 2, 3]},
      {stream: 2, object: 8, offset: 0, size: 2, time: 3066, data: [4, 5]},
    ]),
  );
  assert.deepEqual(
    objects.map((o) => [o.stream, o.time, [...o.data]]),
    [
      [1, 0, [1, 2, 3]],
      [2, 66, [4, 5]],
    ],
  );
  // A compressed payload carries whole objects at one presentation time.
  const compressed = demuxer.packet(
    packet([{stream: 1, object: 2, time: 3200, objects: [[9], [8, 7]]}], {compressed: true}),
  );
  assert.deepEqual(
    compressed.map((o) => [o.stream, o.time, [...o.data]]),
    [
      [1, 200, [9]],
      [1, 200, [8, 7]],
    ],
  );
  // An object abandoned before its last byte is dropped.
  demuxer.packet(packet([{stream: 2, object: 9, offset: 0, size: 10, time: 3100, data: [1, 2]}]));
  assert.deepEqual(
    demuxer
      .packet(packet([{stream: 2, object: 10, offset: 0, size: 1, time: 3133, data: [6]}]))
      .map((o) => [...o.data]),
    [[6]],
  );
  assert.throws(() => demuxer.packet(new Uint8Array(PACKET - 1)), /Truncated ASF data packet/);
});

test('ASF preroll queue releases video after audio muxed up to a preroll late', () => {
  // Video (2) every 500 ms; each audio (1) block covers 1000 ms and is muxed after the video
  // of its end time.
  const objects = [];
  for (let time = 0; time <= 3000; time += 500) {
    objects.push({stream: 2, time});
    if (time >= 1000 && time % 1000 === 0) objects.push({stream: 1, time: time - 1000});
  }
  const queue = new AsfPrerollQueue(1000, 2);
  const order = [];
  for (const object of objects) order.push(...queue.push([object]));
  order.push(...queue.flush());
  // Each video object follows the audio block that covers its time.
  assert.deepEqual(
    order.map((o) => `${o.stream}@${o.time}`),
    ['1@0', '2@0', '2@500', '1@1000', '2@1000', '2@1500', '1@2000', '2@2000', '2@2500', '2@3000'],
  );
});

for (const wasm of [false, true])
  test(`Windows Media decoder emits planar WMA audio, wasm=${wasm}`, () => {
    // Synthetic fixture: 0.6 s of a 440 Hz (left) and 660 Hz (right) sine at 44.1 kHz, encoded
    // as WMA (0x161) by FFmpeg.
    const bytes = new Uint8Array(
      readFileSync(new URL('./fixtures/asf/sine-wmav2.wma', import.meta.url)),
    );
    const layout = readAsfLayout(bytes);
    const [stream] = layout.streams;
    assert.equal(stream.codec, 0x161);
    const decoder = new WindowsMediaDecoder(stream, {wasm});
    assert.equal(decoder.accelerated, wasm);
    const demuxer = new AsfDemuxer(layout);
    const channels = [[], []];
    for (let p = 0; p < layout.packetCount; p++) {
      const at = layout.dataOffset + p * layout.packetSize;
      for (const o of demuxer.packet(bytes.subarray(at, at + layout.packetSize)))
        for (const out of decoder.decode(o.data, o.time, o.key))
          out.channels.forEach((c, i) => channels[i].push(...c));
    }
    for (const out of decoder.decode(null)) out.channels.forEach((c, i) => channels[i].push(...c));
    assert.deepEqual(decoder.decode(null), []);
    assert.deepEqual(decoder.decode(new Uint8Array()), []);
    assert.throws(() => decoder.decode(Uint8Array.of(0)), /decode error -541478725/);
    decoder.close();
    decoder.close();
    assert.equal(channels[0].length, 24576);
    // Goertzel power at the tone frequency dominates a neighbouring frequency.
    const power = (samples, frequency) => {
      const k = 2 * Math.cos((2 * Math.PI * frequency) / 44100);
      let a = 0,
        b = 0;
      for (const x of samples.slice(4096, 20480)) [a, b] = [x + k * a - b, a];
      return a * a + b * b - k * a * b;
    };
    assert.ok(power(channels[0], 440) > 1000 * power(channels[0], 660));
    assert.ok(power(channels[1], 660) > 1000 * power(channels[1], 440));
    assert.throws(() => decoder.decode(new Uint8Array(1)), /closed/);
    assert.throws(
      () => new WindowsMediaDecoder({...stream, codec: 0x160}),
      /Unsupported Windows Media audio codec 0x160/,
    );
  });

test('Movie streams select ASF and require a video stream', async () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/asf/sine-wmav2.wma', import.meta.url)),
  );
  const source = {size: bytes.length, read: async (o, n) => bytes.slice(o, o + n)};
  await assert.rejects(openMovieStream(source), /ASF movie without a video stream/);
});

test('WVC1 Advanced Profile headers initialize the real decoder and require both sequence and entry points', () => {
  const bits = (fields) => {
    const text = fields.map(([width, value]) => value.toString(2).padStart(width, '0')).join('');
    return Buffer.from(
      text
        .padEnd(Math.ceil(text.length / 8) * 8, '0')
        .match(/.{8}/g)
        .map((v) => parseInt(v, 2)),
    );
  };
  // Generated 16x16 progressive, 4:2:0 Advanced Profile sequence and closed entry.
  // FFmpeg's vc1.c owns these syntax fields; there is no movie/image fixture.
  const sequence = Buffer.concat([
    Buffer.from([0, 0, 1, 0x0f]),
    bits([
      [2, 3],
      [3, 0],
      [2, 1],
      [3, 0],
      [5, 0],
      [1, 0],
      [12, 7],
      [12, 7],
      [1, 0],
      [1, 0],
      [1, 0],
      [1, 0],
      [1, 1],
      [1, 0],
      [1, 0],
      [1, 0],
    ]),
  ]);
  const entry = Buffer.concat([
    Buffer.from([0, 0, 1, 0x0e]),
    bits([
      [1, 0],
      [1, 1],
      [1, 0],
      [1, 0],
      [1, 0],
      [1, 0],
      [1, 0],
      [2, 0],
      [1, 0],
      [1, 0],
      [2, 0],
      [1, 0],
      [1, 0],
      [1, 0],
    ]),
  ]);
  const codec = {
    kind: 'video',
    codec: 0x31435657,
    width: 16,
    height: 16,
    extra: Buffer.concat([sequence, entry]),
  };
  const decoder = new WindowsMediaDecoder(codec);
  try {
    assert.deepEqual(decoder.decode(null), []);
  } finally {
    decoder.close();
  }
  assert.throws(() => decoder.decode(null), /closed/);
  const corrupt = new WindowsMediaDecoder(codec);
  try {
    // A frame marker with no picture header must surface the codec failure.
    assert.throws(() => corrupt.decode(Uint8Array.of(0, 0, 1, 0x0d)), /Windows Media decode error/);
  } finally {
    corrupt.close();
  }
  assert.throws(
    () => new WindowsMediaDecoder({...codec, extra: sequence}),
    /Unsupported Windows Media video codec/,
  );
  assert.throws(
    () =>
      new WindowsMediaDecoder({
        ...codec,
        extra: Buffer.concat([Buffer.alloc(sequence.length), entry]),
      }),
    /Unsupported Windows Media video codec/,
  );
  assert.throws(
    () => new WindowsMediaDecoder({...codec, codec: 0x32505657}),
    /Unsupported Windows Media video codec/,
  );
});

for (const wasm of [false, true])
  test(`Windows Media video frames belong to the caller, wasm=${wasm}`, () => {
    const decoder = new WindowsMediaDecoder(
      {
        kind: 'video',
        codec: 0x33564d57,
        width: 16,
        height: 16,
        extra: Buffer.from('4ff94801', 'hex'),
      },
      {wasm},
    );
    assert.equal(decoder.accelerated, wasm);
    const intra = Buffer.from('00100bc0', 'hex'),
      skipped = Buffer.from('28200840', 'hex');
    const [first] = decoder.decode(intra, 12, true);
    assert.equal(first.time, 12);
    assert.equal(first.frame.index, 0);
    assert.equal(first.frame.pictureType, 1);
    assert.deepEqual(first.frame.y, new Uint8Array(256).fill(143));
    first.frame.y.fill(0);
    const [second] = decoder.decode(skipped, 45);
    assert.equal(second.time, 45);
    assert.equal(second.frame.index, 1);
    assert.equal(second.frame.pictureType, 2);
    assert.deepEqual(second.frame.y, new Uint8Array(256).fill(143));
    decoder.decode(intra, 78);
    assert.deepEqual(first.frame.y, new Uint8Array(256));
    assert.deepEqual(second.frame.y, new Uint8Array(256).fill(143));
    assert.deepEqual(decoder.decode(null), []);
    assert.deepEqual(decoder.decode(null), []);
    assert.deepEqual(decoder.decode(new Uint8Array()), []);
    assert.throws(() => decoder.decode(intra), /decode error -541478725/);
    decoder.close();
    assert.throws(() => decoder.decode(null), /closed/);
  });
