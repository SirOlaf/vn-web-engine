import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {decodeVorbisChunks, decodeVorbisFile} from '../dist/audio/vorbis-codec.js';
import {BurikoProgressiveOggDecoder} from '../dist/engines/buriko/native/audio/progressive-ogg.js';
import {createBurikoWaveBoxOggDecoder} from '../dist/engines/buriko/native/audio/wavebox-ogg.js';

const encoded = new Uint8Array(
  await readFile(new URL('./fixtures/audio/vorbis-boundaries.ogg', import.meta.url)),
);

test('chunked Vorbis decoding concatenates to the single-call PCM', async () => {
  const complete = await decodeVorbisFile(encoded);
  const chunks = [];
  let opened = null;
  // One packet per libvorbis call, so this short fixture still yields several chunks.
  const summary = await decodeVorbisChunks(
    encoded,
    700,
    300,
    {
      onOpen: (open) => (opened = open),
      onChunk: (planes, frames) => chunks.push({planes, frames}),
    },
    1,
  );
  assert.deepEqual(opened, {sampleRate: 48000, channels: 1, finalGranule: complete.frames});
  assert.ok(chunks.length >= 3, `several chunks, got ${chunks.length}`);
  assert.ok(chunks[0].frames >= 700);
  for (const chunk of chunks.slice(1, -1)) assert.ok(chunk.frames >= 300);
  assert.equal(summary.frames, complete.frames);
  const joined = new Float32Array(summary.samplesDecoded);
  let at = 0;
  for (const {planes, frames} of chunks) {
    assert.equal(planes[0].length, frames);
    joined.set(planes[0], at);
    at += frames;
  }
  assert.equal(at, summary.samplesDecoded);
  assert.deepEqual(joined.subarray(0, summary.frames), complete.planes[0]);
});

function waveBox(sourceFrameCount, loopStartFrame) {
  const bytes = new Uint8Array(64 + encoded.length),
    view = new DataView(bytes.buffer);
  for (const [offset, value] of [
    [0, 64],
    [4, 0x20207762],
    [8, encoded.length],
    [12, sourceFrameCount],
    [16, 48000],
    [20, 1],
    [24, 1],
    [28, loopStartFrame],
    [48, 3],
  ])
    view.setUint32(offset, value, true);
  bytes.set(encoded, 64);
  return bytes;
}

async function read(decoder, count) {
  const published = [];
  const returned = await decoder.readFrameBytes(count, undefined, (bytes) => published.push(bytes));
  return {
    bytes: published.length ? published[0] : returned,
    position: decoder.decodedFramePosition,
  };
}

for (const prefer24Bit of [false, true])
  test(`progressive Ogg reads equal complete decoding (${prefer24Bit ? 24 : 16}-bit)`, async () => {
    // The header claims more frames than the Vorbis data holds, so reads also hit the PCM end.
    const bytes = waveBox(4500, 1000),
      options = {gain: 0.75, prefer24Bit};
    let disposed = 0;
    const input = {dispose: () => void disposed++};
    const progressive = await BurikoProgressiveOggDecoder.open(bytes, options, input, {
      first: 512,
      chunk: 256,
    });
    assert.ok(progressive !== null);
    const complete = await createBurikoWaveBoxOggDecoder(bytes, options);
    assert.equal(progressive.outputBits, complete.outputBits);
    const steps = [
      (d) => read(d, 300),
      (d) => read(d, 2000),
      async (d) => {
        await d.restartLoop();
        return {position: d.decodedFramePosition};
      },
      (d) => read(d, 5000),
      async (d) => {
        await d.reset();
        return {position: d.decodedFramePosition};
      },
      (d) => read(d, 4500),
      (d) => read(d, 64),
    ];
    for (const [index, step] of steps.entries()) {
      const expected = await step(complete),
        actual = await step(progressive);
      assert.deepEqual(actual, expected, `step ${index}`);
    }
    await progressive.dispose();
    assert.equal(disposed, 1);
  });
