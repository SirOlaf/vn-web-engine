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
import {AokanaNativeLocks} from '../dist/engines/buriko/games/aokana/native/exclusion-locks.js';
import {AokanaSystemTicks} from '../dist/engines/buriko/games/aokana/native/system-ticks.js';
import {AokanaSpeakerContext} from '../dist/engines/buriko/games/aokana/native/audio/speaker.js';
import {AokanaMemorySpeakerBackend} from '../dist/engines/buriko/games/aokana/native/audio/speaker-backend.js';
import {AokanaAudioChannels} from '../dist/engines/buriko/games/aokana/native/audio/channel-registry.js';
import {AokanaAudioArchiveCache} from '../dist/engines/buriko/games/aokana/native/audio/archive-cache.js';
import {AokanaFileStorage} from '../dist/engines/buriko/games/aokana/native/audio/file-storage.js';

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
    locks = new AokanaNativeLocks(actors);
  locks.initializeEngine();
  const backend = new AokanaMemorySpeakerBackend(1000),
    channels = new AokanaAudioChannels(
      new AokanaSpeakerContext(backend),
      locks,
      actors,
      new AokanaSystemTicks({now: () => 0}),
      {prefer24Bit: false},
    );
  channels.initialize({});
  channels.activate();
  const backing = new StoredFileSystem(new MemoryStore(), (p) => p.toLowerCase());
  await backing.commit([
    {kind: 'write', path: '/game/audio/voice.bw', data: wave(16384)},
    {kind: 'write', path: '/game/other/voice.bw', data: wave(-8192)},
  ]);
  const mounted = new AokanaMountedFileMetadata(backing, {
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
  const files = new AokanaProgramFiles(
      mounted,
      new AokanaNativeText(),
      new AokanaProgramMedia(),
      new AokanaMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\game'),
    ),
    cache = new AokanaAudioArchiveCache(channels, files);
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
      const storage = new AokanaFileStorage(files);
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
