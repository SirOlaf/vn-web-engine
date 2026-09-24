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
import {AokanaArchiveFileStorage} from '../dist/engines/buriko/games/aokana/native/audio/archive-storage.js';

function arc(sample) {
  const bytes = new Uint8Array(144 + 72),
    view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('BURIKO ARC20'));
  view.setUint32(12, 1, true);
  bytes.set(new TextEncoder().encode('VOICE.BW'), 16);
  view.setUint32(116, 72, true);
  for (const [offset, value] of [
    [0, 64],
    [4, 0x20207762],
    [8, 8],
    [12, 4],
    [16, 1000],
    [20, 1],
    [48, 1],
  ])
    view.setUint32(144 + offset, value, true);
  for (let i = 0; i < 4; i++) view.setInt16(208 + i * 2, sample, true);
  return bytes;
}
test('distinct audio archive cache reuses actual identities under shared section and feeds PCM consumers', async () => {
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
    {kind: 'write', path: '/game/first.arc', data: arc(16384)},
    {kind: 'write', path: '/game/second.arc', data: arc(-8192)},
  ]);
  const mounted = new AokanaMountedFileMetadata(backing, {
    records: ['first', 'second'].map((name) => ({
      path: `/game/${name}.arc`,
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
      const first = await cache.find('C:\\game\\FIRST.arc', 'voice.bw', actor),
        same = await cache.find('C:\\GAME\\first.ARC', 'Voice.BW', actor),
        second = await cache.find('second.arc', 'voice.bw', actor);
      assert.equal(first.status, 0);
      assert.equal(same.status, 0);
      assert.equal(second.status, 0);
      assert.equal(first.archive, same.archive);
      assert.notEqual(first.archive, second.archive);
      assert.equal(channels.section.depth, 1);
      cache.fastLookup = 1;
      assert.equal(
        (await cache.find('c:\\game\\first.arc', 'voice.bw', actor)).archive,
        first.archive,
      );
      for (const [channel, entry] of [
        [0, first],
        [1, second],
      ]) {
        const storage = new AokanaArchiveFileStorage();
        storages.push(storage);
        assert.equal(await storage.open(entry.archive, 'voice.bw', actor), true);
        const bytes = new Uint8Array(storage.size);
        assert.equal(await storage.readInto({bytes, offset: 0}, bytes.length, actor), 72);
        assert.equal(await channels.attachStatic(channel, bytes, 0, 1, 1), 0);
        assert.equal(await channels.startStatic(channel, 128, 64, actor), 0);
      }
    } finally {
      channels.section.leave(actor);
    }
    assert.deepEqual([...backend.buffers[0].render(4)[0]], [0.5, 0.5, 0.5, 0.5]);
    assert.deepEqual([...backend.buffers[1].render(4)[0]], [-0.25, -0.25, -0.25, -0.25]);
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
