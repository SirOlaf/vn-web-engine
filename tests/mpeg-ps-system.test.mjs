import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {openMovieStream} from '../dist/video/movie.js';

const directory = new URL('./fixtures/mpeg-ps/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function source(bytes) {
  return {
    size: bytes.length,
    reads: [],
    async read(offset, length) {
      assert.ok(offset >= 0 && offset + length <= bytes.length);
      assert.ok(length <= 65536, 'program-stream reads stay bounded');
      this.reads.push([offset, length]);
      return bytes.subarray(offset, offset + length);
    },
  };
}

test('MPEG program streams retain I/P/B presentation and delayed MP2 timing against synthetic FFmpeg output', async () => {
  for (const fixture of manifest.fixtures) {
    const encoded = readFileSync(new URL(fixture.name + '.mpg', directory));
    const reference = gunzipSync(readFileSync(new URL(fixture.name + '.yuv.gz', directory)));
    assert.equal(digest(encoded), fixture.encodedSha256);
    assert.equal(digest(reference), fixture.yuvSha256);
    const input = source(encoded),
      movie = await openMovieStream(input);
    const info = movie.info;
    assert.equal(info.width, fixture.width);
    assert.equal(info.height, fixture.height);
    assert.equal(info.frameRate, fixture.frameRate);
    assert.equal(info.frameCount, fixture.frameCount);
    assert.equal(info.channels, fixture.channels);
    assert.equal(info.sampleRate, fixture.sampleRate);
    assert.equal(info.audioStartTime, fixture.audioStart ?? 0);
    assert.ok(Math.abs(info.duration - 0.6) < 1e-9);
    const frames = [],
      audio = [];
    for (;;) {
      const batch = await movie.next();
      frames.push(...batch.frames);
      audio.push(...batch.audio);
      if (batch.done) break;
    }
    assert.equal(frames.length, fixture.frameCount);
    assert.deepEqual(
      frames.map((f) => ['?', 'I', 'P', 'B'][f.pictureType]),
      fixture.pictureTypes,
    );
    let values = 0,
      peak = 0,
      squared = 0;
    for (const [index, frame] of frames.entries()) {
      assert.equal(frame.index, index);
      assert.ok(Math.abs(frame.timestamp - fixture.videoStart - index / fixture.frameRate) < 1e-9);
      assert.ok(Math.abs(frame.duration - 1 / fixture.frameRate) < 1e-9);
      for (const [plane, width, height, stride] of [
        [frame.y, frame.width, frame.height, frame.stride],
        [frame.cb, frame.width / 2, frame.height / 2, frame.stride / 2],
        [frame.cr, frame.width / 2, frame.height / 2, frame.stride / 2],
      ])
        for (let row = 0; row < height; row++)
          for (let x = 0; x < width; x++) {
            const delta = plane[row * stride + x] - reference[values++];
            peak = Math.max(peak, Math.abs(delta));
            squared += delta * delta;
          }
    }
    assert.equal(values, reference.length);
    assert.ok(peak <= 2, `MPEG-1 integer IDCT peak error ${peak}`);
    assert.ok(Math.sqrt(squared / values) < 0.2, 'MPEG-1 IDCT RMS error');
    if (fixture.channels) {
      const pcm = gunzipSync(readFileSync(new URL(fixture.name + '.f32.gz', directory)));
      assert.equal(digest(pcm), fixture.pcmSha256);
      values = 0;
      peak = 0;
      squared = 0;
      let samples = 0;
      for (const frame of audio) {
        assert.equal(frame.start, samples);
        assert.ok(
          Math.abs(frame.timestamp - fixture.audioStart - samples / fixture.sampleRate) < 1e-9,
        );
        for (let i = 0; i < frame.channels[0].length; i++)
          for (const channel of frame.channels) {
            const delta = channel[i] - pcm.readFloatLE(values++ * 4);
            peak = Math.max(peak, Math.abs(delta));
            squared += delta * delta;
          }
        samples += frame.channels[0].length;
      }
      assert.equal(samples, info.sampleCount);
      assert.equal(values * 4, pcm.length);
      assert.ok(peak < 2e-6, `MP2 peak error ${peak}`);
      assert.ok(Math.sqrt(squared / values) < 3e-7, 'MP2 RMS error');
      assert.ok(Math.abs(info.audioEndTime - 0.272) < 1e-9);
    } else {
      assert.equal(audio.length, 0);
      assert.equal(info.sampleCount, 0);
    }
    assert.ok(input.reads.length >= 3, 'sniff, metadata and decode read independently');
    await assert.rejects(openMovieStream(source(encoded.subarray(0, -1))), /range|Truncated/i);
  }
});
