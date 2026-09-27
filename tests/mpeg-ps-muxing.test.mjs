import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {indexMpegPs} from '../dist/formats/mpeg-ps/index.js';
import {openMovieStream} from '../dist/video/movie.js';

const source = (bytes) => ({
  size: bytes.length,
  async read(offset, length) {
    return bytes.subarray(offset, offset + length);
  },
});
const pack = () => Buffer.from([0, 0, 1, 0xba, 0x21, 0, 1, 0, 1, 0x80, 0, 1]);
function pes(payload, pts = null) {
  const header =
    pts === null
      ? Buffer.from([0x0f])
      : Buffer.from([
          0x21 | ((pts / 2 ** 29) & 0x0e),
          (pts >>> 22) & 0xff,
          ((pts >>> 14) & 0xfe) | 1,
          (pts >>> 7) & 0xff,
          ((pts << 1) & 0xfe) | 1,
        ]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(header.length + payload.length);
  return Buffer.concat([Buffer.from([0, 0, 1, 0xe0]), length, header, payload]);
}
// 16x16 at 29.97 fps; the indexer reads start-code headers only.
const sequence = Buffer.from([0, 0, 1, 0xb3, 0x01, 0x00, 0x10, 0x14, 0, 0, 0, 0]);
const gop = Buffer.from([0, 0, 1, 0xb8, 0, 0, 0, 0]);
const picture = (temporal, type) =>
  Buffer.from([0, 0, 1, 0, temporal >> 2, ((temporal & 3) << 6) | (type << 3), 0, 0]);

test('MPEG-PS timestamps after split sequence headers stay with their picture', async () => {
  // The second GOP's sequence header ends one packet; the packet holding its GOP header and
  // picture carries that picture's timestamp, as in codeX RScript opening movies.
  const stream = Buffer.concat([
    pack(),
    pes(Buffer.concat([sequence, gop, picture(0, 1), sequence]), 1000),
    pes(Buffer.concat([gop, picture(0, 1)]), 1000 + 3003),
    pes(picture(1, 2), 1000 + 2 * 3003),
    Buffer.from([0, 0, 1, 0xb9]),
  ]);
  const index = await indexMpegPs(source(new Uint8Array(stream)));
  assert.deepEqual(
    index.videoTimes.map((t) => Math.round(t * 90000)),
    [0, 3003, 6006],
  );
});

test('MPEG-1 slices may end with zero stuffing before the next start code', async () => {
  const original = readFileSync(new URL('./fixtures/mpeg-ps/video-only.mpg', import.meta.url));
  // Insert four zero bytes after the first slice that ends inside a video packet.
  let stuffed = null;
  for (let at = 0; at + 6 <= original.length && !stuffed; at++) {
    if (original[at] || original[at + 1] || original[at + 2] !== 1 || original[at + 3] !== 0xe0)
      continue;
    const end = at + 6 + original.readUInt16BE(at + 4);
    for (let i = at + 6; i + 4 <= end; i++) {
      const code = original[i + 3];
      if (original[i] || original[i + 1] || original[i + 2] !== 1 || code < 1 || code > 0xaf)
        continue;
      const next = original.indexOf(Buffer.from([0, 0, 1]), i + 4);
      if (next < 0 || next + 3 > end) break;
      const packet = Buffer.from(original.subarray(at, end));
      packet.writeUInt16BE(packet.readUInt16BE(4) + 4, 4);
      stuffed = Buffer.concat([
        original.subarray(0, at),
        packet.subarray(0, next - at),
        Buffer.alloc(4),
        packet.subarray(next - at),
        original.subarray(end),
      ]);
      break;
    }
  }
  assert.ok(stuffed, 'fixture has a slice followed by another start code in one packet');
  const decode = async (bytes) => {
    const movie = await openMovieStream(source(new Uint8Array(bytes)));
    const frames = [];
    for (;;) {
      const batch = await movie.next();
      frames.push(...batch.frames.map((frame) => Buffer.from(frame.y)));
      if (batch.done) return frames;
    }
  };
  assert.deepEqual(await decode(stuffed), await decode(original));
});
