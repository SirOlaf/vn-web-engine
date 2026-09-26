import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoMovieAudioDecoder} from '../dist/engines/buriko/native/movie-audio-decoder.js';

function description() {
  const asc = [5, 2, 0x12, 0x10],
    decoder = [4, 13 + asc.length, 0x40, 0x15, ...new Array(11).fill(0), ...asc];
  const stream = [3, 3 + decoder.length, 0, 1, 0, ...decoder];
  const bytes = new Uint8Array(36 + 12 + stream.length),
    view = new DataView(bytes.buffer);
  view.setUint32(0, bytes.length);
  bytes.set([109, 112, 52, 97], 4);
  view.setUint16(24, 2);
  view.setUint32(32, 44100 * 65536);
  view.setUint32(36, 12 + stream.length);
  bytes.set([101, 115, 100, 115], 40);
  bytes.set(stream, 48);
  return {type: 'mp4a', bytes, headerSize: 8, dataReference: 1};
}
function fixture(timescale = 44100, times = [0n, 1024n, 2048n]) {
  return {
    movie: {bytes: Uint8Array.from(times, () => 1)},
    track: {
      timescale,
      descriptions: [description()],
      dataReferences: [{flags: 1}],
      samples: times.map((compositionTime, index) => ({
        description: 1,
        compositionTime,
        duration: 1024,
        sync: true,
        offset: BigInt(index),
        size: 1,
      })),
    },
  };
}
function install(t, {extra = false, fail = false} = {}) {
  const saved = [globalThis.AudioDecoder, globalThis.EncodedAudioChunk],
    decoders = [];
  class Decoder {
    static async isConfigSupported(config) {
      assert.equal(config.codec, 'mp4a.40.2');
      return {supported: !fail};
    }
    state = 'unconfigured';
    decodeQueueSize = 0;
    outputs = [];
    chunks = [];
    constructor(callbacks) {
      this.callbacks = callbacks;
      decoders.push(this);
    }
    configure() {
      this.state = 'configured';
    }
    emit(timestamp) {
      const data = {
        timestamp,
        numberOfFrames: 2,
        numberOfChannels: 2,
        sampleRate: 44100,
        closed: 0,
        copyTo(destination, options) {
          assert.equal(options.format, 'f32-planar');
          destination.set(options.planeIndex === 0 ? [0.25, -0.5] : [-0.75, 1]);
        },
        close() {
          this.closed++;
        },
      };
      this.outputs.push(data);
      this.callbacks.output(data);
    }
    decode(chunk) {
      this.chunks.push(chunk);
      this.decodeQueueSize++;
      queueMicrotask(() => {
        if (this.state === 'closed') return;
        this.decodeQueueSize--;
        this.emit(chunk.timestamp);
        if (extra) this.emit(chunk.timestamp + 100);
        this.ondequeue?.();
      });
    }
    async flush() {
      await Promise.resolve();
    }
    close() {
      this.state = 'closed';
    }
  }
  globalThis.AudioDecoder = Decoder;
  globalThis.EncodedAudioChunk = class {
    constructor(init) {
      Object.assign(this, init);
    }
  };
  t.after(() => {
    for (const [index, name] of ['AudioDecoder', 'EncodedAudioChunk'].entries())
      if (saved[index] === undefined) delete globalThis[name];
      else globalThis[name] = saved[index];
  });
  return decoders;
}

test('AAC uses real codec timestamps, restores unique ISO origins and keeps actual extra output times', async (t) => {
  const decoders = install(t, {extra: true}),
    {movie, track} = fixture(),
    decoder = await BurikoMovieAudioDecoder.create(movie, track);
  const outputs = [];
  for (;;) {
    const data = await decoder.next();
    if (data === null) break;
    outputs.push(data);
  }
  assert.deepEqual(
    decoders[0].chunks.map(({timestamp}) => timestamp),
    [0, 23219, 46439],
  );
  assert.deepEqual(outputs[2].mediaStart, {numerator: 1024n, denominator: 44100n});
  assert.deepEqual(outputs[3].mediaStart, {numerator: 23319n, denominator: 1000000n});
  assert.deepEqual(
    outputs[0].planes.map((plane) => [...plane]),
    [
      [0.25, -0.5],
      [-0.75, 1],
    ],
  );
  assert.ok(decoders[0].outputs.every((data) => data.closed === 1));
  decoder.dispose();
});

test('AAC cannot invent fractional identity when distinct ISO origins collapse to the same API timestamp', async (t) => {
  install(t);
  const {movie, track} = fixture(10000000, [1n, 2n]);
  const decoder = await BurikoMovieAudioDecoder.create(movie, track);
  assert.deepEqual((await decoder.next()).mediaStart, {numerator: 0n, denominator: 1000000n});
  decoder.dispose();
});

test('AAC reset cancels old reads and closes late codec outputs', async (t) => {
  const decoders = install(t),
    {movie, track} = fixture(),
    decoder = await BurikoMovieAudioDecoder.create(movie, track);
  const pending = decoder.next();
  decoder.reset();
  await assert.rejects(pending, {name: 'AbortError'});
  decoders[0].emit(0);
  assert.equal(decoders[0].outputs.at(-1).closed, 1);
  assert.deepEqual((await decoder.next()).mediaStart, {numerator: 0n, denominator: 44100n});
  decoder.dispose();
});

test('AAC support failure remains a real failed graph capability', async (t) => {
  const decoders = install(t, {fail: true}),
    {movie, track} = fixture();
  await assert.rejects(BurikoMovieAudioDecoder.create(movie, track), {name: 'NotSupportedError'});
  assert.equal(decoders.length, 0);
});
