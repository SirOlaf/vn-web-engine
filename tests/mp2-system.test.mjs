import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {Mp2Decoder, readMp2Header} from '../dist/formats/mp2/decoder.js';

const directory = new URL('./fixtures/mp2/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8'));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('incremental MP2 PCM agrees with synthetic FFmpeg references and rejects broken frames', () => {
  for (const fixture of manifest.fixtures) {
    const encoded = readFileSync(new URL(fixture.name + '.mp2', directory));
    const reference = gunzipSync(readFileSync(new URL(fixture.name + '.f32.gz', directory)));
    assert.equal(digest(encoded), fixture.encodedSha256);
    assert.equal(digest(reference), fixture.pcmSha256);
    const header = readMp2Header(encoded);
    assert.equal(header.sampleRate, fixture.sampleRate);
    assert.equal(header.channels, fixture.channels);
    const decoder = new Mp2Decoder(),
      frames = [];
    const chunks = [1, 2, 3, 7, 127, 577];
    for (let offset = 0, chunk = 0; offset < encoded.length; chunk++) {
      const length = chunks[chunk % chunks.length];
      frames.push(...decoder.push(encoded.subarray(offset, offset + length)));
      offset += length;
    }
    decoder.flush();
    let samples = 0,
      values = 0,
      squaredError = 0,
      maximumError = 0;
    for (const frame of frames) {
      assert.equal(frame.startSample, samples);
      assert.equal(frame.sampleRate, fixture.sampleRate);
      assert.equal(frame.channels.length, fixture.channels);
      for (const channel of frame.channels) assert.equal(channel.length, 1152);
      for (let sample = 0; sample < 1152; sample++)
        for (let channel = 0; channel < fixture.channels; channel++) {
          const actual = frame.channels[channel][sample];
          assert.ok(Number.isFinite(actual));
          const delta = actual - reference.readFloatLE(values++ * 4);
          maximumError = Math.max(maximumError, Math.abs(delta));
          squaredError += delta * delta;
        }
      samples += 1152;
    }
    assert.equal(samples, fixture.samples);
    assert.equal(values * 4, reference.length);
    assert.ok(maximumError < 2e-6, `${fixture.name}: peak error ${maximumError}`);
    assert.ok(Math.sqrt(squaredError / values) < 3e-7, `${fixture.name}: RMS error`);
    assert.throws(() => decoder.push(encoded), /cannot accept/);
    const truncated = new Mp2Decoder();
    truncated.push(encoded.subarray(0, -1));
    assert.throws(() => truncated.flush(), /Truncated MP2 frame/);
    if (header.hasCrc) {
      const broken = Buffer.from(encoded);
      broken[4] ^= 1;
      assert.throws(() => new Mp2Decoder().push(broken), /CRC mismatch/);
    }
  }
  assert.throws(() => new Mp2Decoder().push(Uint8Array.of(0, 0, 0, 0)), /Invalid MP2 frame sync/);
});
