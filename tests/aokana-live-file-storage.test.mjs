import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoMountedFileMetadata} from '../dist/engines/buriko/native/file-metadata.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoMountedProgramPaths} from '../dist/engines/buriko/native/program-paths.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoFileStorage} from '../dist/engines/buriko/native/audio/file-storage.js';
import {createBurikoWaveStatic} from '../dist/engines/buriko/native/audio/wave-static.js';
import {BurikoSpeakerModel} from '../dist/engines/buriko/native/audio/speaker-model.js';
import {
  BurikoSpeakerContext,
  BurikoStaticSpeaker,
} from '../dist/engines/buriko/native/audio/speaker.js';
import {BurikoMemorySpeakerBackend} from '../dist/engines/buriko/native/audio/speaker-backend.js';

test('real loose file storage reads and seeks WaveBox bytes consumed by the actual static PCM speaker', async () => {
  const wave = new Uint8Array(72),
    header = new DataView(wave.buffer);
  for (const [offset, value] of [
    [0, 64],
    [4, 0x20207762],
    [8, 8],
    [12, 4],
    [16, 24000],
    [20, 1],
    [48, 1],
  ])
    header.setUint32(offset, value, true);
  [0, 16384, 0, -16384].forEach((value, i) => header.setInt16(64 + i * 2, value, true));
  const backing = new StoredFileSystem(new MemoryStore(), (p) => p.toLowerCase());
  await backing.commit([{kind: 'write', path: '/game/voice.bw', data: wave}]);
  const mounted = new BurikoMountedFileMetadata(backing, {
    records: [
      {
        path: '/game/voice.bw',
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
  const files = new BurikoProgramFiles(
      mounted,
      new BurikoNativeText(),
      new BurikoProgramMedia(),
      new BurikoMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\game'),
    ),
    storage = new BurikoFileStorage(files),
    actor = {},
    backend = new BurikoMemorySpeakerBackend(24000),
    speaker = new BurikoStaticSpeaker(new BurikoSpeakerContext(backend));
  try {
    assert.equal(await storage.open('C:\\game\\voice.bw'), true);
    assert.equal(storage.flags, 1);
    assert.equal(storage.position, 0);
    assert.equal(storage.size, 72);
    const actual = new Uint8Array(72),
      initialized = new Uint8Array(72);
    assert.equal(await storage.readInto({bytes: actual, offset: 0}, 64, actor, initialized), 64);
    assert.equal(storage.position, 64);
    assert.equal(storage.remaining, 8);
    assert.deepEqual([...initialized.slice(0, 64)], Array(64).fill(1));
    assert.deepEqual([...initialized.slice(64)], Array(8).fill(0));
    assert.equal(await storage.readInto({bytes: actual, offset: 64}, 8, actor, initialized), 8);
    assert.equal(storage.position, 72);
    assert.deepEqual(actual, wave);
    assert.ok(initialized.every((value) => value === 1));
    assert.equal(storage.seek(66), 66);
    const continuation = new Uint8Array(6);
    assert.equal(await storage.readInto({bytes: continuation, offset: 0}, 6, actor), 6);
    assert.deepEqual([...continuation], [0, 64, 0, 0, 0, 192]);
    // Detached bytes are intentionally the fixture's final consumer, not a live-stream claim.
    const decoded = await createBurikoWaveStatic(actual, {gain: 1, prefer24Bit: false});
    assert.equal(await speaker.attach(new BurikoSpeakerModel(decoded)), 0);
    assert.equal(await speaker.start(0), 0);
    const output = backend.buffers[0].render(4);
    assert.deepEqual([...output[0]], [0, 0.5, 0, -0.5]);
    assert.deepEqual([...output[1]], [0, 0.5, 0, -0.5]);
  } finally {
    (await speaker.detach())?.dispose();
    storage.dispose();
  }
});
