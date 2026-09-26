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
import {BurikoNativeLocks} from '../dist/engines/buriko/native/exclusion-locks.js';
import {BurikoSystemTicks} from '../dist/engines/buriko/native/system-ticks.js';
import {BurikoSpeakerContext} from '../dist/engines/buriko/native/audio/speaker.js';
import {BurikoMemorySpeakerBackend} from '../dist/engines/buriko/native/audio/speaker-backend.js';
import {BurikoAudioChannels} from '../dist/engines/buriko/native/audio/channel-registry.js';
import {BurikoAudioArchiveCache} from '../dist/engines/buriko/native/audio/archive-cache.js';
import {BurikoFileStorage} from '../dist/engines/buriko/native/audio/file-storage.js';

function wave(sample) {
  const bytes = new Uint8Array(72),
    view = new DataView(bytes.buffer);
  for (const [offset, value] of [
    [0, 64],
    [4, 0x20207762],
    [8, 8],
    [12, 4],
    [16, 1000],
    [20, 1],
    [48, 1],
  ])
    view.setUint32(offset, value, true);
  for (let i = 0; i < 4; i++) view.setInt16(64 + i * 2, sample, true);
  return bytes;
}
test('shared audio wide path search resolves mounted PCM and real directories in configured order', async () => {
  const actor = {},
    actors = {currentActor: actor},
    locks = new BurikoNativeLocks(actors);
  locks.initializeEngine();
  const backend = new BurikoMemorySpeakerBackend(1000),
    channels = new BurikoAudioChannels(
      new BurikoSpeakerContext(backend),
      locks,
      actors,
      new BurikoSystemTicks({now: () => 0}),
      {prefer24Bit: false},
    );
  channels.initialize({});
  channels.activate();
  const backing = new StoredFileSystem(new MemoryStore(), (p) => p.toLowerCase());
  await backing.commit([
    {kind: 'write', path: '/game/audio/voice.bw', data: wave(16384)},
    {kind: 'write', path: '/game/other/voice.bw', data: wave(-8192)},
  ]);
  const mounted = new BurikoMountedFileMetadata(backing, {
    records: ['audio', 'other'].map((name) => ({
      path: `/game/${name}/voice.bw`,
      kind: 'file',
      attributes: 32,
      creationTime: null,
      accessTime: null,
      writeTime: 123n,
    })),
    volumes: [{path: '/', identity: {}, writable: true}],
    canonical: (p) => p.toLowerCase(),
    currentFileTime: () => 123n,
    accessTimePolicy: 'disabled',
  });
  const files = new BurikoProgramFiles(
      mounted,
      new BurikoNativeText(),
      new BurikoProgramMedia(),
      new BurikoMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\game'),
    ),
    cache = new BurikoAudioArchiveCache(channels, files);
  cache.rootWide = 'C:\\game\\';
  const storages = [];
  try {
    await channels.initializeMasters();
    await channels.section.enter(actor);
    try {
      cache.searchDirectories = ['audio', 'other'];
      const selected = await cache.resolveLoosePath('voice.bw', actor);
      assert.equal(selected, 'C:\\game\\audio\\voice.bw');
      assert.equal(await cache.resolveLoosePath('audio', actor), 'C:\\game\\audio');
      assert.equal(channels.section.depth, 1);
      const storage = new BurikoFileStorage(files);
      storages.push(storage);
      assert.equal(await storage.open(selected), true);
      const bytes = new Uint8Array(storage.size),
        initialized = new Uint8Array(storage.size);
      assert.equal(
        await storage.readInto({bytes, offset: 0}, bytes.length, actor, initialized),
        72,
      );
      assert.ok(initialized.every((value) => value === 1));
      assert.equal(await channels.attachStatic(0, bytes, 0, 1, 1), 0);
      assert.equal(await channels.startStatic(0, 128, 64, actor), 0);
    } finally {
      channels.section.leave(actor);
    }
    assert.deepEqual([...backend.buffers[0].render(4)[0]], [0.5, 0.5, 0.5, 0.5]);
  } finally {
    for (const storage of storages) storage.dispose();
    await channels.section.enter(actor);
    try {
      cache.dispose(actor);
    } finally {
      channels.section.leave(actor);
    }
    await channels.disposeChannels();
  }
});
