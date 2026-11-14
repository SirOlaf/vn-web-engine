import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openSync, readSync, closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Nonvisual PCM throughput and parity. Compressed objects are cached before timing;
// all variants return caller-owned planar float. Hashing is outside timed decode calls.
const [
  path,
  baselineDir,
  currentDir = new URL('../dist/', import.meta.url).pathname,
  count = '300',
] = process.argv.slice(2);
if (!path || !baselineDir)
  throw Error('usage: benchmark-wma.mjs ASF_FILE BASELINE_DIST [CURRENT_DIST] [MAX_OBJECTS=300]');
const max = Number(count);
if (!Number.isSafeInteger(max) || max < 1 || max > 10000) throw Error('Invalid object limit');
const load = (dir, file) => import(new URL(file, pathToFileURL(resolve(dir) + '/')));
const {readAsfLayout, AsfDemuxer} = await load(currentDir, 'formats/asf/demux.js');
const {WindowsMediaDecoder: CurrentDecoder} = await load(currentDir, 'video/windows-media.js');
const {WindowsMediaDecoder} = await load(baselineDir, 'video/windows-media.js');
const fd = openSync(path, 'r');
const read = (at, n) => {
  const bytes = new Uint8Array(n);
  if (readSync(fd, bytes, 0, n, at) !== n) throw Error('Truncated ASF');
  return bytes;
};
let codec,
  packets = [],
  total = 0,
  complete = true;
try {
  const header = read(0, 30),
    length = Number(new DataView(header.buffer).getBigUint64(16, true));
  const layout = readAsfLayout(read(0, length + 50));
  codec = layout.streams.find((s) => s.kind === 'audio');
  if (!codec || ![0x161, 0x162, 0x163].includes(codec.codec)) throw Error('ASF needs WMA audio');
  const demux = new AsfDemuxer(layout);
  outer: for (let p = 0; p < layout.packetCount; p++)
    for (const object of demux.packet(
      read(layout.dataOffset + p * layout.packetSize, layout.packetSize),
    ))
      if (object.stream === codec.number) {
        total += object.data.length;
        if (total > 128 * 1024 * 1024)
          throw Error('Cached input exceeds 128 MiB; reduce MAX_OBJECTS');
        packets.push(object);
        if (packets.length >= max) {
          complete = false;
          break outer;
        }
      }
} finally {
  closeSync(fd);
}
function run(create) {
  const decoder = create(),
    hash = createHash('sha256');
  assert.ok(decoder, 'Requested decoder unavailable');
  let milliseconds = 0,
    frames = 0,
    samples = 0;
  try {
    // A bounded prefix can end mid-frame in the reservoir. Drain only a complete
    // stream; an artificial end would benchmark damaged-packet recovery instead.
    for (const packet of complete ? [...packets, {data: null, time: 0, key: false}] : packets) {
      const t = performance.now();
      const outputs = decoder.decode(packet.data, packet.time, packet.key);
      milliseconds += performance.now() - t;
      for (const {channels, time} of outputs) {
        frames++;
        samples += channels[0].length;
        hash.update(JSON.stringify([channels.length, channels[0].length, time]));
        for (const c of channels) hash.update(new Uint8Array(c.buffer, c.byteOffset, c.byteLength));
      }
    }
  } finally {
    decoder.close();
  }
  return {milliseconds, frames, samples, hash: hash.digest('hex')};
}
function portable(wasm) {
  const decoder = new CurrentDecoder(codec, {wasm});
  assert.equal(decoder.accelerated, wasm, 'Requested backend is unavailable');
  return decoder;
}
const variants = [
  ['baseline', () => new WindowsMediaDecoder(codec)],
  ['wasm', () => portable(true)],
  ['javascript', () => portable(false)],
];
let expected;
const samples = Object.fromEntries(variants.map(([name]) => [name, []]));
for (let repetition = 0; repetition < 6; repetition++)
  for (const [name, create] of variants) {
    const result = run(create);
    expected ??= {frames: result.frames, samples: result.samples, hash: result.hash};
    assert.deepEqual(
      {frames: result.frames, samples: result.samples, hash: result.hash},
      expected,
      name + ' output differs',
    );
    if (repetition) samples[name].push(result.milliseconds);
  }
const results = Object.fromEntries(
  Object.entries(samples).map(([name, values]) => {
    values.sort((a, b) => a - b);
    const ms = values[2];
    return [
      name,
      {medianMs: +ms.toFixed(2), nanosecondsPerSample: +((ms * 1e6) / expected.samples).toFixed(2)},
    ];
  }),
);
console.log(
  JSON.stringify(
    {
      path,
      codec: codec.codec,
      sampleRate: codec.sampleRate,
      bits: codec.bitsPerSample,
      objects: packets.length,
      inputBytes: total,
      complete,
      ...expected,
      results,
    },
    null,
    2,
  ),
);
