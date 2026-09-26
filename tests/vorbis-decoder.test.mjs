import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {decodeVorbis} from '../dist/audio/vorbis-decoder.js';
import {createBurikoWaveStatic} from '../dist/engines/buriko/native/audio/wave-static.js';
import {
  BurikoSpeakerContext,
  BurikoStaticSpeaker,
} from '../dist/engines/buriko/native/audio/speaker.js';
import {BurikoSpeakerModel} from '../dist/engines/buriko/native/audio/speaker-model.js';
import {BurikoMemorySpeakerBackend} from '../dist/engines/buriko/native/audio/speaker-backend.js';

test('Vorbis retains native boundary PCM and completes playback at a different device rate', async () => {
  const encoded = new Uint8Array(
    await readFile(new URL('./fixtures/audio/vorbis-boundaries.ogg', import.meta.url)),
  );
  const goldenBytes = await readFile(
    new URL('./fixtures/audio/vorbis-boundaries.f32', import.meta.url),
  );
  const golden = new DataView(goldenBytes.buffer, goldenBytes.byteOffset, goldenBytes.byteLength);
  const clip = await decodeVorbis(encoded);
  assert.equal(clip.sampleRate, 48000);
  assert.equal(clip.frames, 4109);
  assert.equal(clip.planes.length, 1);
  assert.equal(clip.planes[0].length, 4109);
  for (let index = 0; index < 256; index++) {
    const actual = clip.planes[0][index < 128 ? index : clip.frames - 256 + index];
    assert.ok(
      Math.abs(actual - golden.getFloat32(index * 4, true)) < 1e-6,
      `native boundary sample ${index}`,
    );
  }

  // Feed the same complete PCM through the native static allocation and actual render owner.
  // A browser-truncated result previously failed here before any sound could start.
  const waveBox = new Uint8Array(64 + encoded.length),
    header = new DataView(waveBox.buffer);
  for (const [offset, value] of [
    [0, 64],
    [4, 0x20207762],
    [8, encoded.length],
    [12, clip.frames],
    [16, clip.sampleRate],
    [20, 1],
    [48, 3],
  ])
    header.setUint32(offset, value, true);
  waveBox.set(encoded, 64);
  const wave = await createBurikoWaveStatic(waveBox, {gain: 1, prefer24Bit: false});
  const backend = new BurikoMemorySpeakerBackend(44100);
  const speaker = new BurikoStaticSpeaker(new BurikoSpeakerContext(backend));
  try {
    assert.equal(await speaker.attach(new BurikoSpeakerModel(wave)), 0);
    assert.equal(await speaker.start(0), 0);
    assert.equal(await speaker.status(), 1);
    const output = backend.buffers[0].render(
      Math.ceil((clip.frames * 44100) / clip.sampleRate) + 1,
    );
    assert.ok(output[0].some((sample) => sample !== 0));
    assert.equal(await speaker.status(), 0);
  } finally {
    const model = await speaker.detach();
    await model?.dispose();
  }
});
