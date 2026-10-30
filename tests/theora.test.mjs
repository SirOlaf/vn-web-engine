import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {readTheoraOgg, TheoraDecoder, parseTheoraInfo} from '../dist/formats/theora/index.js';

const directory = new URL('./fixtures/theora/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8'));

function frameHash(decoder, width, height, format) {
  const luma = width * height,
    chroma = (format & 1 ? width : width / 2) * (format & 2 ? height : height / 2);
  const frame = new Uint8Array(luma + 2 * chroma);
  decoder.copyPlane(0, frame.subarray(0, luma));
  decoder.copyPlane(1, frame.subarray(luma, luma + chroma));
  decoder.copyPlane(2, frame.subarray(luma + chroma));
  return createHash('sha256').update(frame).digest('hex');
}

test('Theora frames match libtheora bit for bit in 4:2:0, 4:2:2 and 4:4:4', () => {
  for (const clip of manifest.clips) {
    const bytes = readFileSync(new URL(clip.name + '.ogv', directory));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), clip.file, clip.name);
    const stream = readTheoraOgg(bytes);
    assert.equal(stream.info.pixelFormat, clip.format, clip.name);
    assert.equal(stream.info.macroblockWidth * 16, clip.width, clip.name);
    assert.equal(stream.packets.length, clip.frames.length, clip.name);
    const decoder = new TheoraDecoder(stream.info, stream.setup);
    let duplicates = 0;
    stream.packets.forEach((packet, index) => {
      if (!decoder.decode(packet)) duplicates++;
      assert.equal(
        frameHash(decoder, clip.width, clip.height, clip.format),
        clip.frames[index],
        `${clip.name} frame ${index}`,
      );
    });
    if (clip.name === 'testsrc2-420') assert.ok(duplicates > 0, 'duplicate frames are covered');
  }
});

test('Theora identification header keeps the picture region inside the padded frame', () => {
  const stream = readTheoraOgg(readFileSync(new URL('testsrc2-420.ogv', directory)));
  const {info} = stream;
  assert.deepEqual(
    [info.macroblockWidth, info.macroblockHeight, info.pictureWidth, info.pictureHeight],
    [5, 3, 72, 40],
  );
  assert.deepEqual([info.frameRateNumerator, info.frameRateDenominator], [30, 1]);
  // pictureY counts from the bottom of the frame: the 8 padding rows lie above the picture.
  assert.deepEqual([info.pictureX, info.pictureY], [0, 8]);
  const header = readFileSync(new URL('testsrc2-420.ogv', directory)).subarray(28, 28 + 42);
  assert.deepEqual(parseTheoraInfo(header), info);
  assert.throws(() => parseTheoraInfo(header.subarray(0, 20)), /Truncated Theora/);
});
