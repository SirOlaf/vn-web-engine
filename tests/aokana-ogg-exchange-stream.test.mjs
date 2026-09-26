import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaMemoryAudioStorage} from '../dist/engines/buriko/games/aokana/native/audio/memory-storage.js';
import {AokanaOggExchangeDecoder} from '../dist/engines/buriko/games/aokana/native/audio/ogg-exchange-stream.js';
import {AokanaWaveStream} from '../dist/engines/buriko/games/aokana/native/audio/wave-stream.js';
import {AokanaWaveBoxOggDecoder} from '../dist/engines/buriko/games/aokana/native/audio/wavebox-ogg.js';
import {parseAokanaWaveBoxHeader} from '../dist/engines/buriko/games/aokana/native/audio/wavebox-header.js';

function source(values) {
  const raw = new Uint8Array(64),
    view = new DataView(raw.buffer);
  for (const [offset, value] of [
    [4, 0x20207762],
    [12, values.length],
    [16, 2],
    [20, 1],
    [48, 3],
  ])
    view.setUint32(offset, value, true);
  const storage = new AokanaMemoryAudioStorage(64);
  storage.flags = 3;
  storage.write({bytes: raw, offset: 0}, 64);
  storage.seek(0);
  const link = {
    channels: 1,
    sampleRate: 2,
    shortBlock: 64,
    longBlock: 256,
    frames: values.length,
    planes: [Float32Array.from(values)],
  };
  return {
    storage,
    decoder: new AokanaWaveBoxOggDecoder(parseAokanaWaveBoxHeader(raw), [link], 16, 1),
  };
}

function exchange(rawLoopDword) {
  const first = source([0.25, 0.5]),
    second = source([-0.25, -0.5]);
  return new AokanaOggExchangeDecoder(
    first.decoder,
    second.decoder,
    first.storage,
    second.storage,
    rawLoopDword,
  );
}

function samples(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({length: bytes.length / 2}, (_, index) => view.getInt16(index * 2, true));
}

test('paired decoded OGG links advance first to second and apply the raw DWORD only to second repeats', async () => {
  const once = exchange(0),
    actor = {},
    actors = {currentActor: actor};
  const first = new AokanaWaveStream(once, () => 0, actors);
  try {
    assert.equal(once.activeInput, 0);
    assert.equal(once.loopEnabled, 1);
    assert.equal(first.channels, 1);
    assert.equal(first.sampleRate, 2);
    assert.equal(first.sourceFrameCount, 4);
    await first.initialize(actor);
    assert.equal(once.activeInput, 1);
    assert.equal(once.loopEnabled, 0);
    assert.equal(first.fifo.available, 8);
    const output = new Uint8Array(8);
    assert.equal(await first.readInto(output, 0, 4), 4);
    assert.deepEqual(samples(output), [8192, 16384, -8192, -16384]);
    assert.equal(await first.readInto(new Uint8Array(2), 0, 1), 0);
    await first.reset(actor);
    assert.equal(first.framePosition, 0);
    const replay = new Uint8Array(8);
    assert.equal(await first.readInto(replay, 0, 4), 4);
    assert.deepEqual(samples(replay), [8192, 16384, -8192, -16384]);
  } finally {
    await first.dispose();
  }

  const repeating = exchange(0x80000000),
    second = new AokanaWaveStream(repeating, () => 0, actors);
  try {
    await second.initialize(actor);
    assert.equal(repeating.activeInput, 1);
    assert.equal(repeating.loopEnabled, 0x80000000);
    const output = new Uint8Array(16);
    assert.equal(await second.readInto(output, 0, 8), 8);
    assert.deepEqual(samples(output), [8192, 16384, -8192, -16384, -8192, -16384, -8192, -16384]);
    assert.equal(second.framePosition, 0);
  } finally {
    await second.dispose();
  }
});

test('the first source transition leaves the visible loop count unchanged; a second-source repeat counts', async () => {
  const first = source(Array(8).fill(0.25)),
    second = source(Array(8).fill(-0.25));
  const decoder = new AokanaOggExchangeDecoder(
    first.decoder,
    second.decoder,
    first.storage,
    second.storage,
    1,
  );
  let milliseconds = 0;
  const actor = {},
    stream = new AokanaWaveStream(decoder, () => milliseconds, {currentActor: actor});
  try {
    await stream.initialize(actor);
    assert.equal(decoder.activeInput, 0);
    assert.equal(await stream.readInto(new Uint8Array(16), 0, 8), 8);
    await stream.serviceProducer();
    assert.equal(decoder.activeInput, 1);
    assert.equal(stream.visibleLoopCount, 0);
    assert.equal(await stream.readInto(new Uint8Array(14), 0, 7), 7);
    await stream.serviceProducer();
    assert.equal(stream.visibleLoopCount, 0);
    milliseconds = 4000;
    assert.equal(stream.visibleLoopCount, 1);
  } finally {
    await stream.dispose();
  }
});
