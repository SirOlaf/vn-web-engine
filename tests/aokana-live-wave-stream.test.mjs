import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaMountedFileMetadata} from '../dist/engines/buriko/games/aokana/native/file-metadata.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaFileStorage} from '../dist/engines/buriko/games/aokana/native/audio/file-storage.js';
import {createAokanaLiveWaveStream} from '../dist/engines/buriko/games/aokana/native/audio/wave-stream.js';
import {AokanaSpeakerModel} from '../dist/engines/buriko/games/aokana/native/audio/speaker-model.js';
import {AokanaSpeakerContext} from '../dist/engines/buriko/games/aokana/native/audio/speaker.js';
import {AokanaStreamSpeaker} from '../dist/engines/buriko/games/aokana/native/audio/stream-speaker.js';
import {AokanaMemorySpeakerBackend} from '../dist/engines/buriko/games/aokana/native/audio/speaker-backend.js';

test('live file PCM reads continue through shared FIFO refill, reset and the actual stream speaker', async () => {
  const bytes = new Uint8Array(64 + 5000 * 2),
    view = new DataView(bytes.buffer);
  for (const [offset, value] of [
    [0, 64],
    [4, 0x20207762],
    [8, 10000],
    [12, 5000],
    [16, 1000],
    [20, 1],
    [48, 1],
  ])
    view.setUint32(offset, value, true);
  for (let index = 0; index < 5000; index++) view.setInt16(64 + index * 2, 8192, true);
  const backing = new StoredFileSystem(new MemoryStore(), (p) => p.toLowerCase());
  await backing.commit([{kind: 'write', path: '/game/live.bw', data: bytes}]);
  const mounted = new AokanaMountedFileMetadata(backing, {
    records: [
      {
        path: '/game/live.bw',
        kind: 'file',
        attributes: 32,
        creationTime: null,
        accessTime: null,
        writeTime: 123456789n,
      },
    ],
    volumes: [{path: '/', identity: {}, writable: true}],
    canonical: (p) => p.toLowerCase(),
    currentFileTime: () => 123456789n,
    accessTimePolicy: 'disabled',
  });
  const files = new AokanaProgramFiles(
    mounted,
    new AokanaNativeText(),
    new AokanaProgramMedia(),
    new AokanaMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\game'),
  );
  const storage = new AokanaFileStorage(files),
    actor = {},
    actors = {currentActor: actor};
  assert.equal(await storage.open('C:\\game\\live.bw'), true);
  const stream = await createAokanaLiveWaveStream(storage, 1, {gain: 1}, () => 1000, actors, actor);
  const backend = new AokanaMemorySpeakerBackend(1000),
    speaker = new AokanaStreamSpeaker(new AokanaSpeakerContext(backend));
  const model = new AokanaSpeakerModel(stream);
  try {
    assert.equal(storage.position, 8064); // header64 plus four seconds of mono16.
    assert.equal(stream.fifo.available, 8000);
    const first = new Uint8Array(2000);
    assert.equal(await stream.readInto(first, 0, 1000), 1000);
    assert.ok(new Int16Array(first.buffer).every((value) => value === 8192));
    await stream.serviceProducer();
    // Free1000frames > half-second500, so exactly one block; equality stops refill.
    assert.equal(storage.position, 9064);
    assert.equal(stream.fifo.free, 1000);
    assert.equal(await stream.readInto(first, 0, 500), 500);
    await stream.serviceProducer();
    assert.equal(storage.position, 10064);
    assert.equal(stream.fifo.free, 1000);
    await stream.reset(actor);
    assert.equal(storage.position, 8064);
    assert.equal(stream.framePosition, 0);
    assert.equal(await speaker.attach(model), 0);
    assert.equal(await speaker.start(0), 0);
    const output = backend.buffers[0].render(8);
    assert.deepEqual([...output[0]], Array(8).fill(0.25));
    assert.deepEqual([...output[1]], Array(8).fill(0.25));
    await speaker.stop(actor);
    assert.equal(stream.framePosition, 0);
    assert.equal(storage.position, 8064);
    speaker.checkWorker();
  } finally {
    const detached = await speaker.detach();
    await (detached ?? model).dispose();
  }
});

import {
  createAokanaCustomWaveBoxDecoder,
  createAokanaLiveCustomWaveBoxDecoder,
} from '../dist/engines/buriko/games/aokana/native/audio/wavebox-codecs.js';

function stereoWave(codec, payload) {
  const result = new Uint8Array(64 + payload.length),
    view = new DataView(result.buffer);
  for (const [offset, value] of [
    [0, 64],
    [4, 0x20207762],
    [8, payload.length],
    [12, 2],
    [16, 24000],
    [20, 2],
    [36, 127],
    [44, 127],
    [48, codec],
    [60, 7],
  ])
    view.setUint32(offset, value, true);
  result.set(payload, 64);
  return result;
}
function ordinaryHuffmanPayload() {
  const payload = new Uint8Array(0x408 + 0x400),
    tree = new DataView(payload.buffer, 8, 0x400);
  let nextNode = 256;
  const node = (depth, prefix) => {
    if (depth === 0) return prefix;
    const index = nextNode++,
      zero = node(depth - 1, prefix * 2),
      one = node(depth - 1, prefix * 2 + 1);
    tree.setInt16((index - 256) * 4 + 4, zero, true);
    tree.setInt16((index - 256) * 4 + 6, one, true);
    return index;
  };
  tree.setUint32(0, node(8, 0), true);
  payload.set([0, 128, 1, 129], 0x408);
  return payload;
}
test('actual live ADPCM and Huffman inputs share ordinary stereo arithmetic with synchronous memory decoders', async () => {
  const scenes = [
    {codec: 0, bytes: stereoWave(0, Uint8Array.of(0x10, 0x32)), expected: [15, 47, 94, 158]},
    {codec: 2, bytes: stereoWave(2, ordinaryHuffmanPayload()), expected: [3, -3, 14, -14]},
  ];
  const backing = new StoredFileSystem(new MemoryStore(), (p) => p.toLowerCase());
  await backing.commit(
    scenes.map((scene, index) => ({
      kind: 'write',
      path: `/game/scene${index}.bw`,
      data: scene.bytes,
    })),
  );
  const mounted = new AokanaMountedFileMetadata(backing, {
    records: scenes.map((_, index) => ({
      path: `/game/scene${index}.bw`,
      kind: 'file',
      attributes: 32,
      creationTime: null,
      accessTime: null,
      writeTime: 123456789n,
    })),
    volumes: [{path: '/', identity: {}, writable: true}],
    canonical: (p) => p.toLowerCase(),
    currentFileTime: () => 123456789n,
    accessTimePolicy: 'disabled',
  });
  const files = new AokanaProgramFiles(
    mounted,
    new AokanaNativeText(),
    new AokanaProgramMedia(),
    new AokanaMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\game'),
  );
  const words = (bytes) =>
    Array.from(new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2));
  for (const [index, scene] of scenes.entries()) {
    const memory = createAokanaCustomWaveBoxDecoder(scene.bytes, {gain: 1});
    const immediate = memory.readFrameBytes(2);
    assert.ok(immediate instanceof Uint8Array);
    assert.deepEqual(words(immediate), scene.expected);
    assert.equal(memory.reset(), undefined);
    assert.deepEqual(words(memory.readFrameBytes(2)), scene.expected);
    const storage = new AokanaFileStorage(files),
      actor = {};
    assert.equal(await storage.open(`C:\\game\\scene${index}.bw`), true);
    const live = await createAokanaLiveCustomWaveBoxDecoder(storage, scene.codec, {gain: 1}, actor);
    try {
      assert.deepEqual(words(await live.readFrameBytes(2, actor)), scene.expected);
      await live.reset(actor);
      assert.deepEqual(words(await live.readFrameBytes(2, actor)), scene.expected);
    } finally {
      await live.dispose();
    }
  }
});
