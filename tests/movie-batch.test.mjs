import test from 'node:test';
import assert from 'node:assert/strict';
import {readMovieBatch} from '../dist/video/movie-batch.js';

const info = {
  width: 16,
  height: 16,
  frameRate: 60,
  frameCount: 600,
  duration: 10,
  sampleRate: 44100,
  channels: 2,
  sampleCount: 441000,
};
const frame = (index) => ({
  index,
  timestamp: index / 60,
  y: new Uint8Array(1),
  cb: new Uint8Array(1),
  cr: new Uint8Array(1),
});
const pcm = (start, length) => ({
  start,
  channels: [new Float32Array(length), new Float32Array(length)],
});
const stream = (batches) => ({
  info,
  async next() {
    return {info, progress: 0, frames: [], audio: [], done: false, ...batches.shift()};
  },
});

test('movie batch keeps audio muxed ahead in the packet that completes its frames', async () => {
  // nukitashi movie/o3sfrql9x2.dat at 115.27 s: 8 frames beside 524288 WMA samples (11.9 s).
  const batch = await readMovieBatch(
    stream([{frames: [0, 1, 2, 3, 4, 5, 6, 7].map(frame), audio: [pcm(0, 524288)]}]),
    0,
    () => {},
  );
  assert.equal(batch.frames.length, 8);
  assert.equal(batch.audio[0].channels[0].length, 524288);
  assert.equal(batch.done, false);
});

test('movie batch still refuses audio that piles up without frames', async () => {
  const batches = Array.from({length: 20}, (_, i) => ({audio: [pcm(i * 44100, 44100)]}));
  await assert.rejects(
    readMovieBatch(stream(batches), 0, () => {}),
    /Movie interleave exceeds buffering limit/,
  );
});
