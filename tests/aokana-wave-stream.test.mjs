import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaWaveFifo, AokanaWaveStream, createAokanaWaveStream} from '../dist/engines/buriko/games/aokana/native/audio/wave-stream.js';
import {createAokanaCustomWaveBoxDecoder} from '../dist/engines/buriko/games/aokana/native/audio/wavebox-codecs.js';
function wave(frames = 4, loop = 1, loopStart = 1) {
  const bytes = new Uint8Array(64 + frames * 2), v = new DataView(bytes.buffer);
  for (const [offset, value] of [[0, 64], [4, 0x20207762], [12, frames], [16, 2], [20, 1], [24, loop], [28, loopStart], [48, 1]]) v.setUint32(offset, value, true);
  for (let i = 0; i < frames; i++) v.setInt16(64 + i * 2, (i + 1) * 100, true);
  return bytes;
}
const words = (bytes) => Array.from(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2));
test('native rotation buffer clips writes/reads independently and retains wrap order', () => {
  const fifo = new AokanaWaveFifo(5), output = new Uint8Array(8).fill(99);
  assert.equal(fifo.write(Uint8Array.of(1, 2, 3, 4)), 4);
  assert.equal(fifo.readInto(output, 0, 3), 3);
  assert.equal(fifo.write(Uint8Array.of(5, 6, 7, 8, 9)), 4);
  assert.equal(fifo.readInto(output, 3, 8), 5);
  assert.deepEqual(Array.from(output), [1, 2, 3, 4, 5, 6, 7, 8]);
  fifo.clear(); assert.equal(fifo.free, 5); assert.equal(fifo.available, 0);
});
test('stream prefills four seconds and clears initial loop counters after the producer callbacks', async () => {
  let now = 1000;
  const stream = await createAokanaWaveStream(wave(), {gain: 1, prefer24Bit: false}, () => now);
  try {
    assert.equal(stream.fifo.capacity, 16); assert.equal(stream.fifo.available, 16);
    assert.equal(stream.visibleLoopCount, 0);
    const output = new Uint8Array(10);
    assert.equal(stream.readInto(output, 0, 5), 5);
    assert.deepEqual(words(output), [100, 200, 300, 400, 200]);
    assert.equal(stream.framePosition, 2);
    await stream.serviceProducer();
    assert.equal(stream.fifo.free, 2); // free==half-second threshold does not refill.
    assert.equal(stream.visibleLoopCount, 0);
    now = 5000; assert.equal(stream.visibleLoopCount, 1);
  } finally {stream.dispose();}
});
test('stream reset refills PCM source while preserving the native loop count lifetime', async () => {
  const stream = await createAokanaWaveStream(wave(4, 0), {gain: 1, prefer24Bit: false}, () => 1000);
  try {
    const output = new Uint8Array(12).fill(0xcc);
    assert.equal(stream.readInto(output, 0, 6), 4);
    assert.deepEqual(words(output).slice(0, 4), [100, 200, 300, 400]);
    assert.deepEqual(Array.from(output.subarray(8)), [0xcc, 0xcc, 0xcc, 0xcc]);
    await stream.reset(); assert.equal(stream.framePosition, 0);
    assert.equal(stream.readInto(output, 0, 1), 1); assert.equal(words(output)[0], 100);
  } finally {stream.dispose();}
});
test('mono PCM odd trailing bytes are written even when they are not counted as a consumer frame', async () => {
  const source = Uint8Array.from([...wave(1, 0), 55]), v = new DataView(source.buffer); v.setUint32(12, 2, true);
  const stream = await createAokanaWaveStream(source, {gain: 1, prefer24Bit: false}, () => 1000);
  try {
    const output = new Uint8Array(4).fill(99);
    assert.equal(stream.readInto(output, 0, 2), 1);
    assert.deepEqual(Array.from(output), [100, 0, 55, 99]);
  } finally {stream.dispose();}
});
test('a zero-progress native loop remains pending and disposal can terminate the worker wait', async () => {
  const stream = new AokanaWaveStream(createAokanaCustomWaveBoxDecoder(wave(0, 1, 0), {gain: 1}), () => 1000);
  const pending = stream.initialize();
  assert.ok(pending instanceof Promise);
  setTimeout(() => stream.dispose(), 5);
  await assert.rejects(pending, (error) => error.name === 'AbortError');
});
