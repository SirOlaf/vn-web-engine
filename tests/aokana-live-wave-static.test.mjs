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
import {createBurikoLiveWaveStatic} from '../dist/engines/buriko/native/audio/wave-static.js';
import {BurikoSpeakerModel} from '../dist/engines/buriko/native/audio/speaker-model.js';
import {
  BurikoSpeakerContext,
  BurikoStaticSpeaker,
} from '../dist/engines/buriko/native/audio/speaker.js';
import {BurikoMemorySpeakerBackend} from '../dist/engines/buriko/native/audio/speaker-backend.js';

test('live static factory decodes real mounted PCM input into the actual static speaker owner', async () => {
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
    const decoded = await createBurikoLiveWaveStatic(storage, 1, {gain: 1}, actor);
    assert.equal(decoded.pcm.bytes.length, 8);
    assert.ok(decoded.pcm.initialized.every((value) => value === 1));
    assert.equal(await speaker.attach(new BurikoSpeakerModel(decoded)), 0);
    assert.equal(await speaker.start(0), 0);
    const output = backend.buffers[0].render(4);
    assert.deepEqual([...output[0]], [0, 0.5, 0, -0.5]);
    assert.deepEqual([...output[1]], [0, 0.5, 0, -0.5]);
  } finally {
    await (await speaker.detach())?.dispose();
  }
});
