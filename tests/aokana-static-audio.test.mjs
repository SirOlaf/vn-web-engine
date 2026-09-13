import test from 'node:test';
import assert from 'node:assert/strict';
import {crossfadeAokanaStaticPcm, timeScaleAokanaStaticPcm} from '../dist/engines/buriko/games/aokana/native/audio/static-pcm.js';
import {AokanaWaveStatic, createAokanaWaveStatic, fadeInAokanaStaticPcm} from '../dist/engines/buriko/games/aokana/native/audio/wave-static.js';
import {parseAokanaWaveBoxHeader} from '../dist/engines/buriko/games/aokana/native/audio/wavebox-header.js';
function pcm(values, bits = 16) {
  const width = bits / 8, bytes = new Uint8Array(values.length * width);
  values.forEach((value, index) => {for (let byte = 0; byte < width; byte++) bytes[index * width + byte] = value >> (byte * 8);});
  return {bytes, initialized: new Uint8Array(bytes.length).fill(1)};
}
function samples(storage, bits = 16) {
  const out = [], bytes = storage.bytes, width = bits / 8;
  for (let at = 0; at < bytes.length; at += width) {
    let value = bytes[at]; for (let byte = 1; byte < width; byte++) value |= bytes[at + byte] << (byte * 8);
    out.push(bits === 8 ? value : value << (32 - bits) >> (32 - bits));
  }
  return out;
}
function wave(values, {field08 = values.length * 2, frames = values.length, loop = 0, loopStart = 0} = {}) {
  const bytes = new Uint8Array(64 + values.length * 2), view = new DataView(bytes.buffer);
  for (const [offset, value] of [[0, 64], [4, 0x20207762], [8, field08], [12, frames], [16, 1000], [20, 1], [24, loop], [28, loopStart], [48, 1]]) view.setUint32(offset, value, true);
  bytes.set(pcm(values).bytes, 64); return bytes;
}
test('short 16/24-bit joins retain the nominal five-millisecond denominator', () => {
  for (const bits of [16, 24]) {
    const source = pcm([0, 100, 200, 1000, 1100, 1200], bits), result = pcm([99, 99, 99], bits);
    crossfadeAokanaStaticPcm(result, 0, source, 0, 3 * bits / 8, 3, 1000, 1, bits);
    assert.deepEqual(samples(result, bits), [0, 350, 700]);
    crossfadeAokanaStaticPcm(result, 0, source, 0, 3 * bits / 8, 1, 200, 1, bits);
    assert.equal(samples(result, bits)[0], -(2 ** (bits - 1)));
  }
});
test('8-bit join uses its final-tenth source window and integer tail boundary', () => {
  const source = pcm([...new Array(20).fill(100), ...new Array(20).fill(200)], 8), output = pcm(new Array(20).fill(0), 8);
  crossfadeAokanaStaticPcm(output, 0, source, 0, 20, 20, 48000, 1, 8);
  assert.deepEqual(samples(output, 8), [100, 105, ...new Array(18).fill(200)]);
});
test('static time scaling preserves native thirty-millisecond skips and unwritten allocation tails', () => {
  const source = pcm(Array.from({length: 10}, (_, index) => index));
  const fast = timeScaleAokanaStaticPcm(source, 10, 100, 1, 16, 2);
  assert.equal(fast.allocatedFrames, 6); assert.equal(fast.writtenLength, 12);
  assert.deepEqual(samples(fast), [0, 1, 2, 6, 7, 8]);
  const slow = timeScaleAokanaStaticPcm(source, 10, 100, 1, 16, 0.5);
  assert.equal(slow.allocatedFrames, 21); assert.equal(slow.writtenLength, 30);
  assert.deepEqual(samples(slow).slice(0, 15), [0, 1, 2, 2, 3, 4, 4, 5, 6, 6, 7, 8, 8, 9, 9]);
  assert.deepEqual(slow.initialized.subarray(30), new Uint8Array(12));
  assert.throws(() => timeScaleAokanaStaticPcm(source, 10, 0, 1, 16, 2), /divides by zero/);
  source.initialized[2] = 0;
  assert.equal(timeScaleAokanaStaticPcm(source, 10, 100, 1, 16, 1).initialized[2], 0);
  assert.throws(() => timeScaleAokanaStaticPcm(source, 10, 100, 1, 16, 2), /unwritten/);
});
test('static fade-in uses signed DWORD products, SSE refinement, and preserves samples beyond the duration', () => {
  for (const bits of [16, 24]) {
    const source = pcm([1000, -1000, 2000, -2000, 99], bits);
    assert.equal(fadeInAokanaStaticPcm(source, 5, 1000, 1, bits, 4), 0);
    assert.deepEqual(samples(source, bits), [0, -250, 1000, -1500, 99]);
    assert.equal(fadeInAokanaStaticPcm(source, 5, 1000, 1, bits, 6), 0xffffffff);
    assert.deepEqual(samples(source, bits), [0, -250, 1000, -1500, 99]);
  }
});
test('static PCM source has separate decoded capacity, playback cursor, and native EOF sentinel', async () => {
  const model = await createAokanaWaveStatic(wave([100, 200], {field08: 2}), {gain: 1, prefer24Bit: false});
  const output = new Uint8Array(4).fill(99);
  assert.equal(model.readInto(output, 0, 2), 1);
  assert.deepEqual(Array.from(output), [100, 0, 99, 99]);
  assert.equal(model.readInto(output, 0, 1), 0x7fffffff);
  assert.equal(model.framePosition, 0x80000000);
  model.reset(); assert.equal(model.readInto(output, 0, 1), 1);
  model.dispose(); assert.throws(() => model.reset(), (error) => error.name === 'AbortError');
});
test('static PCM loop seek retains the native source-frame-count divided-by-four offset', () => {
  const source = wave([100, 200, 300, 400], {loop: 1, loopStart: 1});
  const model = new AokanaWaveStatic(parseAokanaWaveBoxHeader(source), 16, source.subarray(64));
  const output = new Uint8Array(10);
  assert.equal(model.readInto(output, 0, 5), 5);
  assert.deepEqual(Array.from(output), [100, 0, 200, 0, 44, 1, 144, 1, 0, 200]);
  assert.equal(model.framePosition, 2);
});
