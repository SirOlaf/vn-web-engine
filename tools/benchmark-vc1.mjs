import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openSync, readSync, closeSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Nonvisual video-only throughput and parity. Input media objects are cached before timing;
// each backend copies identical cropped output frames. No decoded media is displayed or saved.
// Usage: benchmark-vc1.mjs ASF_FILE BASELINE_DIST [CURRENT_DIST] [MAX_PICTURES=300]
const [
  path,
  baselineDir,
  currentDir = new URL('../dist/', import.meta.url).pathname,
  count = '300',
] = process.argv.slice(2);
if (!path || !baselineDir)
  throw Error('usage: benchmark-vc1.mjs ASF_FILE BASELINE_DIST [CURRENT_DIST] [MAX_PICTURES=300]');
const max = Number(count);
if (!Number.isSafeInteger(max) || max < 1 || max > 10000) throw Error('Invalid picture limit');
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
  total = 0;
try {
  const header = read(0, 30);
  const length = Number(new DataView(header.buffer).getBigUint64(16, true));
  const layout = readAsfLayout(read(0, length + 50));
  codec = layout.streams.find((s) => s.kind === 'video');
  if (!codec) throw Error('ASF has no video stream');
  const demux = new AsfDemuxer(layout);
  outer: for (let p = 0; p < layout.packetCount; p++)
    for (const object of demux.packet(
      read(layout.dataOffset + p * layout.packetSize, layout.packetSize),
    ))
      if (object.stream === codec.number) {
        total += object.data.length;
        if (total > 128 * 1024 * 1024)
          throw Error('Cached input exceeds 128 MiB; reduce MAX_PICTURES');
        packets.push(object);
        if (packets.length >= max) break outer;
      }
} finally {
  closeSync(fd);
}

function portable(wasm) {
  const decoder = new CurrentDecoder(codec, {wasm});
  assert.equal(decoder.accelerated, wasm, 'Requested backend is unavailable');
  return decoder;
}
function run(create) {
  const decoder = create(),
    hash = createHash('sha256');
  let milliseconds = 0,
    pictures = 0;
  try {
    for (const packet of [...packets, {data: null, time: 0, key: false}]) {
      const t = performance.now();
      const outputs = decoder.decode(packet.data, packet.time, packet.key);
      milliseconds += performance.now() - t;
      // Hashing is outside the timed decoder call, for all variants.
      for (const {frame: f, time} of outputs) {
        pictures++;
        hash.update(JSON.stringify([f.width, f.height, f.index, f.pictureType, time]));
        for (const [plane, stride, w, h] of [
          [f.y, f.stride, f.width, f.height],
          [f.cb, f.stride >> 1, (f.width + 1) >> 1, (f.height + 1) >> 1],
          [f.cr, f.stride >> 1, (f.width + 1) >> 1, (f.height + 1) >> 1],
        ])
          for (let y = 0; y < h; y++) hash.update(plane.subarray(y * stride, y * stride + w));
      }
    }
  } finally {
    decoder.close();
  }
  return {milliseconds, pictures, hash: hash.digest('hex')};
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
    expected ??= {pictures: result.pictures, hash: result.hash};
    assert.deepEqual(
      {pictures: result.pictures, hash: result.hash},
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
      {
        medianMs: +ms.toFixed(2),
        millisecondsPerPicture: +(ms / expected.pictures).toFixed(3),
        picturesPerSecond: +((expected.pictures * 1000) / ms).toFixed(1),
      },
    ];
  }),
);
console.log(
  JSON.stringify(
    {
      path,
      codec: codec.codec,
      width: codec.width,
      height: codec.height,
      objects: packets.length,
      inputBytes: total,
      ...expected,
      results,
    },
    null,
    2,
  ),
);
