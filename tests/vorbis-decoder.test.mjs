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

test('Vorbis first-page synchronization is opt-in, bounded and skips bad-CRC candidates without changing PCM', async () => {
  const {decodeVorbisFile, VorbisDecodeError} = await import('../dist/audio/vorbis-codec.js');
  const {readOggPage} = await import('../dist/formats/ogg/page.js');
  const encoded = new Uint8Array(
    await readFile(new URL('./fixtures/audio/vorbis-boundaries.ogg', import.meta.url)),
  );
  const expected = await decodeVorbisFile(encoded);
  const prefixed = (prefix) => {
    const result = new Uint8Array(prefix.length + encoded.length);
    result.set(prefix);
    result.set(encoded, prefix.length);
    return result;
  };
  const corrupt = Uint8Array.from(readOggPage(encoded, 0).bytes);
  corrupt[22] ^= 1;
  const synced = await decodeVorbisFile(prefixed(corrupt), {firstPageSearchBoundary: 65536});
  assert.deepEqual(synced, expected);
  await assert.rejects(decodeVorbisFile(prefixed(new Uint8Array(64))), VorbisDecodeError);
  assert.deepEqual(
    await decodeVorbisFile(prefixed(new Uint8Array(65535)), {firstPageSearchBoundary: 65536}),
    expected,
  );
  await assert.rejects(
    decodeVorbisFile(prefixed(new Uint8Array(65536)), {firstPageSearchBoundary: 65536}),
    /boundary/,
  );
  const incomplete = new Uint8Array(27 + 255);
  incomplete.set(encoded.subarray(0, 27));
  incomplete[26] = 255;
  incomplete.fill(255, 27);
  await assert.rejects(
    decodeVorbisFile(prefixed(incomplete), {firstPageSearchBoundary: 65536}),
    /Incomplete Ogg sync page/,
  );
  await assert.rejects(decodeVorbisFile(encoded, {firstPageSearchBoundary: 0}), /Invalid/);
});

test('Rev.2898 sound lookup accepts a prefixed Vorbis stream in its first loader without a rewind', async () => {
  const {createArtemisBufferedSoundDecoder} =
    await import('../dist/engines/artemis/buffered-sound-decoder.js');
  const {decodeArtemisVorbisBytes} = await import('../dist/engines/artemis/vorbis-byte-decode.js');
  const revisions = await import('../dist/engines/artemis/revision.js');
  const hash = revisions.ARTEMIS_2898_EXECUTABLE_SHA256;
  const encoded = new Uint8Array(
    await readFile(new URL('./fixtures/audio/vorbis-boundaries.ogg', import.meta.url)),
  );
  const wrapped = new Uint8Array(64 + encoded.length);
  new DataView(wrapped.buffer).setUint32(4, 0x20207762, true);
  wrapped.set(encoded, 64);
  const bytes = await decodeArtemisVorbisBytes({hash, rounding: 'nearest-even', bytes: encoded});
  const clipOwner = createArtemisBufferedSoundDecoder(
    hash,
    async (path) => (path === 'effect.ogg' ? wrapped : null),
    'nearest-even',
  );
  try {
    const clip = await clipOwner.decode('effect.ogg', -1);
    assert.equal(clip.sampleCount, 4109);
    assert.equal(clip.sampleRate, 48000);
    const decoded = await decodeArtemisVorbisBytes({
      hash,
      rounding: 'nearest-even',
      bytes: wrapped,
    });
    assert.deepEqual(decoded, bytes);
    assert.ok(clip.channels[0].some((sample) => sample !== 0));
    for (const name of [
      'ARTEMIS_3179_EXECUTABLE_SHA256',
      'ARTEMIS_3139_EXECUTABLE_SHA256',
      'ARTEMIS_3139_RESOURCE_VARIANT_SHA256',
      'ARTEMIS_3257_EXECUTABLE_SHA256',
    ])
      assert.equal(
        await decodeArtemisVorbisBytes({
          hash: revisions[name],
          rounding: 'nearest-even',
          bytes: wrapped,
        }),
        null,
      );
  } finally {
    clipOwner.close();
  }
});

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
