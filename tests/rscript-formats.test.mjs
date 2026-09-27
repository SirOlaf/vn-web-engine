import test from 'node:test';
import assert from 'node:assert/strict';
import {XflArchive} from '../dist/formats/rscript/xfl.js';
import {decodeWcg, readWcgHeader} from '../dist/formats/rscript/wcg.js';
import {LwgImage} from '../dist/formats/rscript/lwg.js';
import {decodeGscInstruction, parseGsc} from '../dist/formats/rscript/gsc.js';
import {parseFsc} from '../dist/formats/rscript/fsc.js';
import {parseWave, waveOggStream, wavePcmPlanes} from '../dist/formats/riff/wave.js';
import {RSCRIPT_1_11_LAYOUTS} from '../dist/engines/rscript/vm/layouts.js';
import {gsc} from './rscript-fixtures.mjs';

const memory = (bytes) => ({
  size: bytes.length,
  read: async (offset, length) => bytes.slice(offset, offset + length),
});

function xfl(files) {
  const index = Buffer.alloc(files.length * 40);
  let data = Buffer.alloc(0);
  files.forEach(([name, body], i) => {
    index.write(name, i * 40, 'latin1');
    index.writeUInt32LE(data.length, i * 40 + 32);
    index.writeUInt32LE(body.length, i * 40 + 36);
    data = Buffer.concat([data, body]);
  });
  const header = Buffer.alloc(12);
  header.write('LB', 0, 'latin1');
  header.writeUInt16LE(1, 2);
  header.writeUInt32LE(index.length, 4);
  header.writeUInt32LE(files.length, 8);
  return new Uint8Array(Buffer.concat([header, index, data]));
}

test('XFL archives resolve names case-insensitively against the index base', async () => {
  const archive = await XflArchive.open(
    memory(
      xfl([
        ['0001.gsc', Buffer.from('abc')],
        ['Track01.wav', Buffer.from('wxyz')],
      ]),
    ),
  );
  assert.deepEqual(
    archive.entries.map((e) => [e.name, e.size]),
    [
      ['0001.gsc', 3],
      ['Track01.wav', 4],
    ],
  );
  const track = archive.find('TRACK01.WAV');
  assert.equal(Buffer.from(await archive.read(track)).toString(), 'wxyz');
  assert.equal(archive.find('missing.wav'), undefined);
  await assert.rejects(XflArchive.open(memory(new Uint8Array(12))), /Not an XFL/);
  const truncated = xfl([['a.bin', Buffer.from('12345')]]).slice(0, -1);
  await assert.rejects(XflArchive.open(memory(truncated)), /Invalid range/);
  await assert.rejects(
    XflArchive.open(
      memory(
        xfl([
          ['a.bin', Buffer.alloc(1)],
          ['A.BIN', Buffer.alloc(1)],
        ]),
      ),
    ),
    /duplicate/,
  );
});

class BitWriter {
  bits = [];
  write(value, count) {
    for (let i = count - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
  bytes() {
    const out = new Uint8Array(Math.ceil(this.bits.length / 8));
    this.bits.forEach((bit, i) => (out[i >> 3] |= bit << (7 - (i & 7))));
    return out;
  }
}

/** Reference encoder for the WCG prefix code used by the tests. */
function writeIndex(bits, index, prefixBits, escape) {
  if (index < 2) {
    bits.write(1, prefixBits);
    bits.write(index, 1);
    return;
  }
  const width = Math.floor(Math.log2(index));
  const prefix = Math.min(width + 1, escape);
  bits.write(prefix, prefixBits);
  for (let i = prefix - 1; i < width; i++) bits.write(1, 1);
  if (prefix === escape) bits.write(0, 1);
  bits.write(index - 2 ** width, width);
}

function plane(values, wide, useRuns = true) {
  const table = [...new Set(values)];
  const prefixBits = wide && table.length > 0x1000 ? 4 : 3;
  const escape = prefixBits === 4 ? 15 : 7;
  const bits = new BitWriter();
  for (let i = 0; i < values.length;) {
    let run = 1;
    while (useRuns && run < 17 && values[i + run] === values[i]) run++;
    if (run >= 2) {
      bits.write(0, prefixBits);
      bits.write(run - 2, 4);
    } else run = 1;
    writeIndex(bits, table.indexOf(values[i]), prefixBits, escape);
    i += run;
  }
  const packed = bits.bytes();
  const header = Buffer.alloc(12);
  header.writeUInt32LE(values.length, 0);
  header.writeUInt32LE(packed.length, 4);
  header.writeUInt16LE(table.length, 8);
  const tableBytes = Buffer.alloc(table.length * (wide ? 2 : 1));
  table.forEach((v, i) => (wide ? tableBytes.writeUInt16LE(v, i * 2) : (tableBytes[i] = v)));
  return Buffer.concat([header, tableBytes, packed]);
}

function wcg(width, height, pixels, wide) {
  const header = Buffer.alloc(16);
  header.writeUInt16LE(0x4757, 0);
  header.writeUInt16LE(wide ? 0x71 : 0x11, 2);
  header.writeUInt32LE(0x40000020, 4);
  header.writeUInt32LE(width, 8);
  header.writeUInt32LE(height, 12);
  const words = new Uint16Array(pixels.buffer, pixels.byteOffset, pixels.length / 2);
  const planes = wide
    ? [1, 0].map((start) =>
        plane(
          [...words].filter((_, i) => i % 2 === start),
          true,
        ),
      )
    : [3, 2, 1, 0].map((channel) =>
        plane(
          [...pixels].filter((_, i) => i % 4 === channel),
          false,
        ),
      );
  return new Uint8Array(Buffer.concat([header, ...planes]));
}

test('WCG byte planes decode literals, runs and escaped palette indexes', () => {
  const width = 17,
    height = 9;
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i++)
    pixels[i] = i % 4 === 3 ? (i < 40 ? 0 : 255) : (i * 37 + (i >> 5)) & 0xff;
  const image = decodeWcg(wcg(width, height, pixels, false));
  assert.equal(image.width, width);
  assert.deepEqual(image.pixels, pixels);
  assert.deepEqual(readWcgHeader(wcg(width, height, pixels, false)), {flags: 0x11, width, height});
});

test('WCG 16-bit planes use extended escapes and four-bit prefixes for large palettes', () => {
  for (const [width, height] of [
    [16, 16],
    [96, 96],
  ]) {
    const pixels = new Uint8Array(width * height * 4);
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 131 + (i >> 3) * 7) & 0xff;
    const encoded = wcg(width, height, pixels, true);
    assert.deepEqual(decodeWcg(encoded).pixels, pixels);
    assert.throws(() => decodeWcg(encoded.subarray(0, encoded.length - 1)), /Truncated|range/);
  }
});

test('WCG flags without colour planes fill transparency only', () => {
  const pixels = new Uint8Array(4 * 4);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = i;
  const encoded = Buffer.from(wcg(2, 2, pixels, false));
  encoded.writeUInt16LE(0x01, 2);
  const planeSize = 12 + 4 + encoded.readUInt32LE(16 + 4);
  const decoded = decodeWcg(new Uint8Array(encoded.subarray(0, 16 + planeSize)));
  assert.deepEqual(decoded.pixels, pixels);
  encoded.writeUInt16LE(0x02, 2);
  assert.throws(() => decodeWcg(new Uint8Array(encoded)), /version/);
});

test('LWG layers keep native order, signed positions and data-relative offsets', async () => {
  // '顔' is 0x8A 0xE7 in Shift-JIS.
  const names = [Buffer.from('bg'), Buffer.from([0x8a, 0xe7])];
  const bodies = [Buffer.from('first'), Buffer.from('second!')];
  const index = Buffer.concat(
    names.map((encodedName, i) => {
      const entry = Buffer.alloc(18);
      entry.writeInt32LE(i ? -5 : 7, 0);
      entry.writeInt32LE(i ? 11 : -2, 4);
      entry[8] = 8;
      entry.writeUInt32LE(i ? bodies[0].length : 0, 9);
      entry.writeUInt32LE(bodies[i].length, 13);
      entry[17] = encodedName.length;
      return Buffer.concat([entry, encodedName]);
    }),
  );
  const header = Buffer.alloc(24);
  header.writeUInt16LE(0x474c, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt32LE(720, 4);
  header.writeUInt32LE(1280, 8);
  header.writeUInt16LE(2, 12);
  header.writeUInt32LE(index.length, 20);
  const dataSize = Buffer.alloc(4);
  dataSize.writeUInt32LE(bodies[0].length + bodies[1].length);
  const image = await LwgImage.open(
    memory(new Uint8Array(Buffer.concat([header, index, dataSize, ...bodies]))),
  );
  assert.equal(image.width, 1280);
  assert.equal(image.height, 720);
  assert.deepEqual(
    image.entries.map((e) => [e.name, e.x, e.y, e.format]),
    [
      ['bg', 7, -2, 8],
      ['顔', -5, 11, 8],
    ],
  );
  assert.equal(Buffer.from(await image.read(image.find('顔'))).toString(), 'second!');
});

test('GSC programs expose strings, arrays, labels and decode both instruction families', () => {
  const code = Buffer.alloc(64);
  let p = 0;
  code.writeUInt16LE(0x1800, p); // vars[@0] = immediate, result register 1
  code.writeUInt16LE(1, p + 2);
  code.writeInt16LE(700, p + 4);
  code.writeInt16LE(-3, p + 6);
  p += 8;
  code.writeUInt16LE(0xf100, p);
  code.writeUInt16LE(0, p + 2);
  code.writeInt16LE(1, p + 4);
  p += 6;
  code.writeUInt16LE(0x79, p); // layer directory
  code.writeUInt32LE(0x20005, p + 2); // value 5 through two indirections
  code.writeUInt32LE(1, p + 6);
  p += 10;
  code.writeUInt16LE(0x05, p);
  code.writeUInt32LE(0, p + 2);
  p += 6;
  const bytes = gsc({
    code: code.subarray(0, p),
    strings: ['', 'grpo_bu0'],
    arrays: [[4, -1, 9]],
    labels: [['TOP', 14]],
  });
  const program = parseGsc(bytes);
  assert.equal(Buffer.from(program.strings[1]).toString(), 'grpo_bu0');
  assert.deepEqual([...program.arrays[1]], [4, -1, 9]);
  assert.equal(program.arrays[0].length, 0);
  assert.equal(Buffer.from(program.labels[1].name).toString(), 'TOP');
  assert.equal(program.labels[1].offset, 14);
  const decoded = [];
  for (let offset = 0; offset < program.code.length;) {
    const instruction = decodeGscInstruction(program.code, offset, RSCRIPT_1_11_LAYOUTS);
    decoded.push([instruction.opcode, ...instruction.operands]);
    offset = instruction.next;
  }
  assert.deepEqual(decoded, [
    [0x1800, 1, 700, -3],
    [0xf100, 0, 1],
    [0x79, 0x20005, 1],
    [0x05, 0],
  ]);
  const unknown = Buffer.from([0x07, 0x00]);
  assert.throws(
    () => decodeGscInstruction(unknown, 0, RSCRIPT_1_11_LAYOUTS),
    /Unknown GSC opcode 0x7/,
  );
  const broken = Buffer.from(bytes);
  broken.writeUInt32LE(bytes.length + 1, 0);
  assert.throws(() => parseGsc(new Uint8Array(broken)), /header/);
});

function wave(formatTag, channels, rate, bits, data, fact) {
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'latin1');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(formatTag, 8);
  fmt.writeUInt16LE(channels, 10);
  fmt.writeUInt32LE(rate, 12);
  fmt.writeUInt16LE((channels * bits) / 8, 20);
  fmt.writeUInt16LE(bits, 22);
  const chunks = [fmt];
  if (fact !== undefined) {
    const c = Buffer.alloc(12);
    c.write('fact', 0, 'latin1');
    c.writeUInt32LE(4, 4);
    c.writeUInt32LE(fact, 8);
    chunks.push(c);
  }
  const d = Buffer.alloc(8);
  d.write('data', 0, 'latin1');
  d.writeUInt32LE(data.length, 4);
  chunks.push(d, data);
  const body = Buffer.concat(chunks);
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(body.length + 4, 4);
  riff.write('WAVE', 8, 'latin1');
  return new Uint8Array(Buffer.concat([riff, body]));
}

test('RIFF WAVE exposes PCM planes and Vorbis ACM Ogg payloads', () => {
  const pcm = Buffer.alloc(8);
  pcm.writeInt16LE(-32768, 0);
  pcm.writeInt16LE(16384, 2);
  pcm.writeInt16LE(0, 4);
  pcm.writeInt16LE(32767, 6);
  const planes = wavePcmPlanes(parseWave(wave(1, 2, 44100, 16, pcm)));
  assert.deepEqual([...planes[0]], [-1, 0]);
  assert.deepEqual([...planes[1]], [0.5, 32767 / 32768]);
  const page = (serial, sequence, payload) => {
    const header = Buffer.alloc(28);
    header.write('OggS', 0, 'latin1');
    header.writeUInt32LE(serial, 14);
    header.writeUInt32LE(sequence, 18);
    header[26] = 1;
    header[27] = payload.length;
    return Buffer.concat([header, payload]);
  };
  const first = page(7, 0, Buffer.from('head')),
    second = page(7, 1, Buffer.from('audio'));
  // The ACM encoder interleaves empty pages of another serial and pads the chunk.
  const ogg = Buffer.concat([first, page(0xffffffff, 0, Buffer.alloc(0)), second, Buffer.alloc(1)]);
  const vorbis = parseWave(wave(0x6771, 2, 44100, 16, ogg, 1234));
  assert.equal(vorbis.sampleFrames, 1234);
  assert.deepEqual(Buffer.from(waveOggStream(vorbis)), Buffer.concat([first, second]));
  assert.equal(
    waveOggStream(parseWave(wave(0x6771, 2, 44100, 16, Buffer.from('raw'))))?.length,
    undefined,
  );
  assert.throws(() => parseWave(new Uint8Array(12)), /RIFF/);
});

test('FSC frame scripts compile labels, holds, jumps and native comment quirks', () => {
  const script = [
    '# timer notes compile to frame 0',
    ':begin',
    '?800 99 end\t;finish',
    '?rnd 4 begin',
    '',
    '  2  ',
    '.',
    '>begin',
    ':end',
    ';a comment-only line compiles to frame 0',
    '-',
    ':begin',
    '>missing',
  ].join('\r\n');
  assert.deepEqual(parseFsc(new Uint8Array(Buffer.from(script, 'latin1'))), [
    {op: 'frame', frame: 0},
    {op: 'if', variable: 800, value: 99, target: 6},
    {op: 'random', range: 4, target: 1},
    {op: 'frame', frame: 2},
    {op: 'hold'},
    {op: 'jump', target: 1},
    {op: 'frame', frame: 0},
    {op: 'end'},
    {op: 'jump', target: 0},
  ]);
});
