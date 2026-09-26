import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoMovieVideoDecoder} from '../dist/engines/buriko/native/movie-video-decoder.js';
import {
  BurikoMovieVideoSamples,
  burikoCopyMoviePicture,
} from '../dist/engines/buriko/native/movie-video-samples.js';

function description(profile = 100) {
  const bytes = new Uint8Array(101),
    view = new DataView(bytes.buffer);
  view.setUint32(0, 101);
  bytes.set([97, 118, 99, 49], 4);
  view.setUint16(32, 16);
  view.setUint16(34, 16);
  view.setUint32(86, 15);
  bytes.set([97, 118, 99, 67, 1, profile, 0, 31, 255, 224, 0], 90);
  return {type: 'avc1', bytes, headerSize: 8, dataReference: 1};
}
function fixture(count = 5) {
  const track = {
    timescale: 30000,
    duration: BigInt(count * 1001),
    movieDuration: 0n,
    edits: [],
    descriptions: [description(), description(77)],
    dataReferences: [{flags: 1}],
    samples: Array.from({length: count}, (_, index) => ({
      description: 1,
      offset: BigInt(index),
      size: 1,
      duration: 1001,
      decodeTime: BigInt(index * 1001),
      compositionTime: index < 2 ? 0n : BigInt(index * 1001),
      sync: index % 3 === 0,
    })),
  };
  return {
    movie: {timescale: 1000, bytes: Uint8Array.from({length: count}, (_, index) => index)},
    track,
  };
}

/** A controlled platform decoder verifies transport/lifetime; no compressed game data is decoded. */
function install(t, {order, fail = false, hold = false} = {}) {
  const saved = [globalThis.VideoDecoder, globalThis.EncodedVideoChunk];
  const decoders = [];
  class Chunk {
    constructor(data) {
      Object.assign(this, data);
    }
  }
  class Decoder {
    static async isConfigSupported(config) {
      return {supported: !fail, config};
    }
    state = 'unconfigured';
    decodeQueueSize = 0;
    held = [];
    calls = [];
    frames = [];
    constructor(callbacks) {
      this.callbacks = callbacks;
      decoders.push(this);
    }
    configure(config) {
      this.state = 'configured';
      this.calls.push(['configure', config.codec]);
    }
    emit(token) {
      const frame = {
        timestamp: token,
        visibleRect: {x: 0, y: 0, width: 1, height: 2},
        async copyTo(bytes, options) {
          assert.equal(options.format, 'BGRA');
          bytes.set([token, 2, 3, 255, token + 10, 5, 6, 255]);
          return options.layout;
        },
        closed: 0,
        close() {
          this.closed++;
        },
      };
      this.frames.push(frame);
      this.callbacks.output(frame);
    }
    decode(chunk) {
      this.calls.push(['decode', chunk.timestamp, chunk.duration]);
      this.decodeQueueSize++;
      queueMicrotask(() => {
        if (this.state === 'closed') return;
        this.decodeQueueSize--;
        if (order || hold) this.held.push(chunk.timestamp);
        else this.emit(chunk.timestamp);
        this.ondequeue?.();
      });
    }
    async flush() {
      this.calls.push(['flush']);
      if (hold)
        return new Promise((resolve, reject) => {
          this.abortFlush = () => reject(new DOMException('Closed', 'AbortError'));
        });
      await Promise.resolve();
      for (const token of order ?? this.held) if (this.held.includes(token)) this.emit(token);
      this.held.length = 0;
    }
    close() {
      this.state = 'closed';
      this.abortFlush?.();
    }
  }
  globalThis.VideoDecoder = Decoder;
  globalThis.EncodedVideoChunk = Chunk;
  t.after(() => {
    if (saved[0] === undefined) delete globalThis.VideoDecoder;
    else globalThis.VideoDecoder = saved[0];
    if (saved[1] === undefined) delete globalThis.EncodedVideoChunk;
    else globalThis.EncodedVideoChunk = saved[1];
  });
  return decoders;
}

test('AVC preserves real output ordering, duplicate ISO times and missing picture outputs', async (t) => {
  const decoders = install(t, {order: [1, 0, 3, 4]}),
    {movie, track} = fixture();
  const decoder = await BurikoMovieVideoDecoder.create(movie, track),
    output = [];
  for (;;) {
    const picture = await decoder.next();
    if (picture === null) break;
    output.push(picture);
  }
  assert.deepEqual(
    output.map(({sampleIndex}) => sampleIndex),
    [1, 0, 3, 4],
  );
  assert.deepEqual(
    decoders[0].calls.filter(([kind]) => kind === 'decode').map(([, token]) => token),
    [0, 1, 2, 3, 4],
  );
  assert.equal(decoders[0].calls.find(([kind]) => kind === 'decode')[2], 33366);
  decoder.dispose();
  assert.ok(
    output.every(({frame}) => frame.closed === 0),
    'returned frames remain reader-owned',
  );
  output.forEach(({frame}) => frame.close());
});

test('AVC seek cancels in-flight flush, discards queued pictures and resumes at sync', async (t) => {
  const decoders = install(t, {hold: true}),
    {movie, track} = fixture();
  const decoder = await BurikoMovieVideoDecoder.create(movie, track);
  const pending = decoder.next();
  while (!decoders[0].abortFlush) await Promise.resolve();
  assert.equal(decoder.seek(4), 3);
  await assert.rejects(pending, {name: 'AbortError'});
  decoders[0].emit(0);
  assert.equal(decoders[0].frames[0].closed, 1, 'late old-generation output is closed');
  const next = decoder.next();
  while (!decoders[1].abortFlush) await Promise.resolve();
  assert.deepEqual(
    decoders[1].calls.filter(([kind]) => kind === 'decode').map(([, index]) => index),
    [3, 4],
  );
  decoder.dispose();
  await assert.rejects(next, {name: 'AbortError'});
});

test('AVC flushes the previous sample description before configuring the next', async (t) => {
  const decoders = install(t),
    {movie, track} = fixture(2);
  track.samples[1] = {...track.samples[1], description: 2, sync: true};
  const decoder = await BurikoMovieVideoDecoder.create(movie, track);
  for (;;) {
    const picture = await decoder.next();
    if (picture === null) break;
    picture.frame.close();
  }
  assert.deepEqual(
    decoders[0].calls.map(([kind]) => kind),
    ['configure', 'decode', 'flush', 'configure', 'decode', 'flush'],
  );
  decoder.dispose();
});

test('AVC capability rejection creates no decoder and never substitutes a successful source', async (t) => {
  const decoders = install(t, {fail: true}),
    {movie, track} = fixture();
  await assert.rejects(BurikoMovieVideoDecoder.create(movie, track), {name: 'NotSupportedError'});
  assert.equal(decoders.length, 0);
});

test('video splitter applies forward, reverse and dwell edits to actual codec output', async (t) => {
  const decoders = install(t),
    {movie, track} = fixture();
  track.timescale = 1000;
  track.duration = 50n;
  track.samples.forEach((sample, index) => {
    sample.compositionTime = BigInt(index * 10);
    sample.duration = 10;
  });
  track.edits = [
    {duration: 10n, mediaTime: 10n, rate: 65536},
    {duration: 20n, mediaTime: 40n, rate: -65536},
    {duration: 5n, mediaTime: 5n, rate: 0},
  ];
  const source = await BurikoMovieVideoSamples.create(movie, track),
    outputs = [];
  for (;;) {
    const output = await source.next();
    if (output === null) break;
    outputs.push([
      output.sample.storage.bytes[4],
      output.sample.time.start,
      output.sample.time.end,
      output.sample.discontinuity,
    ]);
    const type = new DataView(output.type.format.buffer);
    assert.equal(
      type.getInt32(56, true),
      2,
      'positive native requested height survives dimension mode 1',
    );
    assert.equal(type.getBigInt64(40, true), 100000n);
    assert.deepEqual(
      [...output.sample.storage.bytes],
      [outputs.at(-1)[0] + 10, 5, 6, 255, outputs.at(-1)[0], 2, 3, 255],
    );
    output.release();
    assert.throws(() => output.sample.storage.range(0, 1, true), /released/);
  }
  assert.deepEqual(outputs, [
    [1, 0n, 100000n, true],
    [3, 100000n, 200000n, true],
    [2, 200000n, 300000n, false],
    [0, 300000n, 350000n, true],
  ]);
  source.dispose();
  assert.ok(decoders.every((decoder) => decoder.frames.every((frame) => frame.closed === 1)));
});

test('video splitter seek preserves negative preroll sample times relative to segment start', async (t) => {
  install(t);
  const {movie, track} = fixture(2);
  track.timescale = 1000;
  track.duration = 20n;
  track.samples.forEach((sample, index) => {
    sample.compositionTime = BigInt(index * 10);
    sample.duration = 10;
  });
  const source = await BurikoMovieVideoSamples.create(movie, track);
  source.seek(50000n);
  const first = await source.next();
  assert.deepEqual(first.sample.time, {start: -50000n, end: 50000n});
  first.release();
  const second = await source.next();
  assert.deepEqual(second.sample.time, {start: 50000n, end: 150000n});
  second.release();
  assert.equal(await source.next(), null);
  source.dispose();
});

test('RGB conversion uses the explicit browser color conversion and rejects absent visible data', async () => {
  await assert.rejects(
    burikoCopyMoviePicture({visibleRect: null}, {start: 0n, end: 1n}, 1n, false),
    {name: 'InvalidStateError'},
  );
});
