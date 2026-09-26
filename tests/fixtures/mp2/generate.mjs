// Synthetic signals only. Regenerate with FFMPEG=/path/to/ffmpeg node generate.mjs.
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';

const ffmpeg = process.env.FFMPEG ?? '/opt/homebrew/bin/ffmpeg';
const directory = new URL('./', import.meta.url);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const encode = (input, sampleRate, channels, bitrate) =>
  execFileSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'f32le',
      '-ar',
      String(sampleRate),
      '-ac',
      String(channels),
      '-i',
      'pipe:0',
      '-c:a',
      'mp2',
      '-b:a',
      String(bitrate),
      '-f',
      'mp2',
      'pipe:1',
    ],
    {input},
  );
const decode = (input) =>
  execFileSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-err_detect',
      'crccheck+explode',
      '-c:a',
      'mp2float',
      '-i',
      'pipe:0',
      '-f',
      'f32le',
      '-c:a',
      'pcm_f32le',
      'pipe:1',
    ],
    {input},
  );
const fixtures = [];
function save(name, encoded, sampleRate, channels, description) {
  const reference = decode(encoded);
  writeFileSync(new URL(name + '.mp2', directory), encoded);
  writeFileSync(new URL(name + '.f32.gz', directory), gzipSync(reference));
  fixtures.push({
    name,
    sampleRate,
    channels,
    description,
    samples: reference.length / (4 * channels),
    encodedSha256: sha256(encoded),
    pcmSha256: sha256(reference),
  });
}
for (const [sampleRate, channels, bitrate] of [
  [44100, 2, 192000],
  [48000, 2, 192000],
  [32000, 1, 128000],
]) {
  const count = 1152 * 8,
    input = Buffer.alloc(count * channels * 4);
  for (let sample = 0; sample < count; sample++)
    for (let ch = 0; ch < channels; ch++) {
      const amplitude = sample < 1152 * 5 ? (ch === 0 ? 0.25 : 0.125) : 0;
      input.writeFloatLE(
        amplitude * Math.sin((2 * Math.PI * (ch === 0 ? 440 : 997) * sample) / sampleRate),
        (sample * channels + ch) * 4,
      );
    }
  save(
    'tone-' + sampleRate + '-' + channels,
    encode(input, sampleRate, channels, bitrate),
    sampleRate,
    channels,
    'Independent440/997Hz tone channels followed by exact zero input; encoder-generated frames.',
  );
}

// Independently construct valid Layer II joint-stereo frames with one shared
// grouped-quantized subband and different channel scalefactors. The reference
// decode must validate their CRC. This is synthetic coded data, not game audio.
const joint = [];
for (let frame = 0; frame < 8; frame++) {
  const bits = [];
  const put = (value, width) => {
    for (let bit = width - 1; bit >= 0; bit--) bits.push((value >>> bit) & 1);
  };
  put(0xfffca040, 32); // MPEG1, LayerII, CRC,192kbps,44100Hz, joint bound4.
  put(0, 16);
  for (let sb = 0; sb < 30; sb++) {
    const width = sb < 11 ? 4 : sb < 23 ? 3 : 2;
    put(sb === 4 ? 1 : 0, width);
    if (sb < 4) put(0, width);
  }
  put(2, 2);
  put(2, 2); // One scalefactor per channel, shared across the frame.
  let crc = 0xffff;
  for (const [start, end] of [
    [16, 32],
    [48, bits.length],
  ])
    for (let bit = start; bit < end; bit++)
      crc = ((crc << 1) ^ ((crc >>> 15) ^ bits[bit] ? 0x8005 : 0)) & 0xffff;
  for (let bit = 0; bit < 16; bit++) bits[32 + bit] = (crc >>> (15 - bit)) & 1;
  put(6, 6);
  put(12, 6); // Right channel amplitude is a quarter of the left.
  for (let granule = 0; granule < 12; granule++) put((granule * 7 + frame) % 27, 5);
  const bytes = Buffer.alloc(Math.floor((144000 * 192) / 44100));
  for (let bit = 0; bit < bits.length; bit++) bytes[bit >>> 3] |= bits[bit] << (7 - (bit & 7));
  joint.push(bytes);
}
save(
  'joint-crc-44100',
  Buffer.concat(joint),
  44100,
  2,
  'Constructed joint-stereo grouped samples with independent6/12 scalefactors and validated LayerII CRC.',
);
writeFileSync(
  new URL('manifest.json', directory),
  JSON.stringify(
    {
      generator: 'generate.mjs',
      reference: execFileSync(ffmpeg, ['-version'], {encoding: 'utf8'}).split('\n')[0],
      fixtures,
    },
    null,
    2,
  ) + '\n',
);
