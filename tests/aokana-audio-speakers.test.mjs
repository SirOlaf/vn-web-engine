import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoMemorySpeakerBackend} from '../dist/engines/buriko/native/audio/speaker-backend.js';
import {
  BurikoSpeakerContext,
  BurikoStaticSpeaker,
} from '../dist/engines/buriko/native/audio/speaker.js';
import {BurikoStreamSpeaker} from '../dist/engines/buriko/native/audio/stream-speaker.js';
import {BurikoSpeakerModel} from '../dist/engines/buriko/native/audio/speaker-model.js';
import {createBurikoWaveStatic} from '../dist/engines/buriko/native/audio/wave-static.js';
import {createBurikoWaveStream} from '../dist/engines/buriko/native/audio/wave-stream.js';

function pcm(samples, rate) {
  const bytes = new Uint8Array(64 + samples.length * 2),
    view = new DataView(bytes.buffer);
  for (const [offset, value] of [
    [0, 64],
    [4, 0x20207762],
    [8, samples.length * 2],
    [12, samples.length],
    [16, rate],
    [20, 1],
    [48, 1],
  ])
    view.setUint32(offset, value, true);
  samples.forEach((value, index) => view.setInt16(64 + index * 2, value, true));
  return bytes;
}
function close(actual, expected) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) =>
    assert.ok(Math.abs(value - expected[index]) < 1e-7, `${index}: ${value} != ${expected[index]}`),
  );
}

test('static speaker owns real WaveBox fill, level application, pause and restart through memory PCM output', async () => {
  const backend = new BurikoMemorySpeakerBackend(24000),
    speaker = new BurikoStaticSpeaker(new BurikoSpeakerContext(backend));
  const wave = await createBurikoWaveStatic(pcm([0, 16384, 0, -16384], 24000), {
    gain: 1,
    prefer24Bit: false,
  });
  const model = new BurikoSpeakerModel(wave);
  try {
    assert.equal(await speaker.attach(model), 0);
    assert.equal(speaker.descriptor.flags, 0x180e8);
    assert.equal(speaker.descriptor.byteLength, 8);
    assert.equal(new DataView(speaker.descriptor.waveFormat.buffer).getUint32(20, true), 4);
    assert.equal(await speaker.start(20), 0);
    const buffer = backend.buffers[0];
    close(buffer.render(2)[0], [0, 0.05]);
    assert.equal(await speaker.pause(1), 0);
    assert.equal(await speaker.status(), 0);
    assert.equal(await speaker.pause(0), 0);
    close(buffer.render(2)[1], [0, -0.05]);
    assert.equal(await speaker.stop(), 0);
    assert.equal(wave.framePosition, 0);
    assert.equal(await speaker.setPan(128), 0);
    assert.equal(await speaker.start(0), 0);
    const output = buffer.render(4);
    close(output[0], [0, 0, 0, 0]);
    close(output[1], [0, 0.5, 0, -0.5]);
    assert.equal(await speaker.status(), 0);
  } finally {
    (await speaker.detach())?.dispose();
  }
});

test('stream speaker fills and refills its real five-block ring from the existing WaveBox FIFO worker', async () => {
  const backend = new BurikoMemorySpeakerBackend(1000),
    speaker = new BurikoStreamSpeaker(new BurikoSpeakerContext(backend));
  const samples = Array.from({length: 2000}, (_, index) => (Math.floor(index / 100) + 1) * 1024);
  const wave = await createBurikoWaveStream(
    pcm(samples, 1000),
    {gain: 1, prefer24Bit: false},
    () => 0,
  );
  const model = new BurikoSpeakerModel(wave);
  try {
    assert.equal(await speaker.attach(model), 0);
    assert.equal(wave.framePosition, 400);
    assert.equal(speaker.blockFrames, 100);
    assert.equal(speaker.descriptor.flags, 0x181e8);
    assert.equal(speaker.descriptor.byteLength, 1000);
    assert.equal(await speaker.start(0), 0);
    // Yield to the actual notification worker, without status-driven refill.
    await new Promise((resolve) => setTimeout(resolve, 0));
    speaker.checkWorker();
    assert.equal(wave.framePosition, 500);
    const buffer = backend.buffers[0];
    for (let block = 0; block < 6; block++) {
      const output = buffer.render(100);
      close(output[0], Array(100).fill((block + 1) / 32));
      close(output[1], Array(100).fill((block + 1) / 32));
      await new Promise((resolve) => setTimeout(resolve, 0));
      speaker.checkWorker();
    }
    assert.equal(await speaker.status(), 1);
    assert.equal(await speaker.stop(), 0);
    assert.equal(wave.framePosition, 0);
  } finally {
    (await speaker.detach())?.dispose();
  }
});
