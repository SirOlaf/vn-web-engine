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
import {BurikoAudioResourceStreams} from '../dist/engines/buriko/native/audio/resource-streams.js';
import {Buriko1665ArchiveFileStorage} from '../dist/engines/buriko/native/audio/1665-archive-storage.js';
import {
  BURIKO_BP_ABI_169,
  BURIKO_BP_ABI_1665,
  BURIKO_BP_ABI_172,
} from '../dist/engines/buriko/bp/abi.js';

function arc(sample, pack) {
  const payload = pack ? 48 : 144,
    bytes = new Uint8Array(payload + 64 + 5000 * 2),
    view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode(pack ? 'PackFile    ' : 'BURIKO ARC20'));
  view.setUint32(12, 1, true);
  bytes.set(new TextEncoder().encode('VOICE.BW'), 16);
  view.setUint32(pack ? 36 : 116, 10064, true);
  for (const [offset, value] of [
    [0, 64],
    [4, 0x20207762],
    [8, 10000],
    [12, 5000],
    [16, 1000],
    [20, 1],
    [48, 1],
  ])
    view.setUint32(payload + offset, value, true);
  for (let i = 0; i < 5000; i++) view.setInt16(payload + 64 + i * 2, sample, true);
  return bytes;
}
for (const [abi, pack] of [
  [BURIKO_BP_ABI_169, true],
  [BURIKO_BP_ABI_1665, false],
  [BURIKO_BP_ABI_1665, true],
  [BURIKO_BP_ABI_172, false],
])
  test(`BGI ${abi.revision} stream admission replaces loose PCM with ${pack ? 'PackFile' : 'ARC20'}`, async () => {
    const actor = {},
      actors = {currentActor: actor},
      locks = new BurikoNativeLocks(actors);
    locks.initializeEngine();
    const backend = new BurikoMemorySpeakerBackend(1000),
      channels = new BurikoAudioChannels(
        new BurikoSpeakerContext(backend, abi),
        locks,
        actors,
        new BurikoSystemTicks({now: () => 0}),
        {prefer24Bit: false},
      );
    channels.initialize({});
    channels.activate();
    const backing = new StoredFileSystem(new MemoryStore(), (p) => p.toLowerCase());
    await backing.commit([
      {
        kind: 'write',
        path: '/game/loose.bw',
        data: arc(16384, pack).slice(pack ? 48 : 144),
      },
      {kind: 'write', path: '/game/second.arc', data: arc(-8192, pack)},
    ]);
    const mounted = new BurikoMountedFileMetadata(backing, {
      records: ['loose.bw', 'second.arc'].map((name) => ({
        path: `/game/${name}`,
        kind: 'file',
        attributes: 32,
        creationTime: null,
        accessTime: null,
        writeTime: abi.revision === '1.665' ? null : 123n,
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
    const resources = new BurikoAudioResourceStreams(channels, cache, files, abi);
    try {
      await channels.initializeMasters();
      assert.equal(await resources.loadLoose(0, 'loose.bw', 128, 64, 1, actor), 0);
      assert.equal(channels.section.depth, 0);
      const first = channels.stream[0].model;
      assert.ok(first);
      assert.equal(channels.stream[0].active, 1);
      assert.equal(await channels.stream[0].speaker.start(0), 0);
      assert.deepEqual([...backend.buffers[0].render(8)[0]], Array(8).fill(0.5));
      assert.equal(await resources.loadArchive(0, 'second.arc', 'VOICE.BW', 128, 64, 1, actor), 0);
      assert.equal(channels.section.depth, 0);
      assert.notEqual(channels.stream[0].model, first);
      assert.equal(channels.stream[0].active, 1);
      assert.equal(channels.stream[0].levels.volume.current, 128);
      assert.equal(await channels.stream[0].speaker.start(0), 0);
      assert.deepEqual([...backend.buffers[1].render(8)[0]], Array(8).fill(-0.25));
      assert.deepEqual([...backend.buffers[1].render(8)[1]], Array(8).fill(-0.25));
      assert.equal(
        await resources.loadPairLoose(0, 'loose.bw', 'loose.bw', 1, 128, 64, 1, actor),
        0,
      );
      assert.equal(channels.stream[0].model.wave.loopEnabled, 2);
      assert.equal(await channels.stream[0].speaker.start(0), 0);
      assert.deepEqual([...backend.buffers[2].render(8)[0]], Array(8).fill(0.5));
      assert.equal(
        await resources.loadPairArchive(
          0,
          'second.arc',
          'VOICE.BW',
          'VOICE.BW',
          0,
          128,
          64,
          1,
          actor,
        ),
        0,
      );
      assert.equal(channels.stream[0].model.wave.loopEnabled, 0);
      assert.equal(await channels.stream[0].speaker.start(0), 0);
      assert.deepEqual([...backend.buffers[3].render(8)[0]], Array(8).fill(-0.25));
      await channels.stream[0].speaker.stop(actor);
      assert.equal(channels.stream[0].model.wave.framePosition, 0);
      channels.stream[0].speaker.checkWorker();
    } finally {
      await channels.disposeChannels();
      await channels.section.enter(actor);
      try {
        cache.dispose(actor);
      } finally {
        channels.section.leave(actor);
      }
    }
  });

test('BGI 1.665 archive storage retains its first duplicate index while reading current file bytes', async () => {
  function duplicateArc(offset, size, payload) {
    const bytes = new Uint8Array(272 + payload.length),
      view = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode('BURIKO ARC20'));
    view.setUint32(12, 2, true);
    for (const [entry, memberOffset, memberSize] of [
      [0, offset, size],
      [1, 4, 4],
    ]) {
      bytes.set(new TextEncoder().encode('VOICE'), 16 + entry * 128);
      view.setUint32(112 + entry * 128, memberOffset, true);
      view.setUint32(116 + entry * 128, memberSize, true);
    }
    bytes.set(payload, 272);
    return bytes;
  }
  const backing = new StoredFileSystem(new MemoryStore(), (p) => p.toLowerCase()),
    files = new BurikoProgramFiles(
      backing,
      new BurikoNativeText(),
      new BurikoProgramMedia(),
      new BurikoMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\game'),
    ),
    actor = {},
    storage = new Buriko1665ArchiveFileStorage(files),
    nextOwner = new Buriko1665ArchiveFileStorage(files),
    output = new Uint8Array(4);
  await backing.commit([
    {
      kind: 'write',
      path: '/game/second.arc',
      data: duplicateArc(0, 4, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8)),
    },
  ]);
  try {
    assert.equal(await storage.open('second.arc', 'VOICE'), true);
    assert.equal(storage.size, 4);
    assert.equal(await storage.readInto({bytes: output, offset: 0}, 4, actor), 4);
    assert.deepEqual([...output], [1, 2, 3, 4]);
    await backing.commit([
      {
        kind: 'write',
        path: '/game/second.arc',
        data: duplicateArc(4, 2, Uint8Array.of(9, 10, 11, 12, 13, 14, 15, 16)),
      },
    ]);
    assert.equal(await storage.open('SECOND.ARC', 'voice'), true);
    assert.equal(storage.size, 4);
    assert.equal(await storage.readInto({bytes: output, offset: 0}, 4, actor), 4);
    assert.deepEqual([...output], [9, 10, 11, 12]);
    assert.equal(await nextOwner.open('second.arc', 'voice'), true);
    assert.equal(nextOwner.size, 2);
    assert.equal(await nextOwner.readInto({bytes: output, offset: 0}, 4, actor), 2);
    assert.deepEqual([...output.subarray(0, 2)], [13, 14]);
    await backing.commit([
      {
        kind: 'write',
        path: '/game/second.arc',
        data: duplicateArc(0, 4, Uint8Array.of(17)),
      },
    ]);
    storage.seek(0);
    assert.equal(await storage.readInto({bytes: output, offset: 0}, 4, actor), 1);
    assert.equal(storage.position, 1);
    assert.equal(output[0], 17);
    await backing.commit([{kind: 'delete', path: '/game/second.arc'}]);
    assert.equal(await storage.readInto({bytes: output, offset: 0}, 1, actor), 0x80000010);
    assert.equal(storage.position, 0x80000011);
  } finally {
    storage.dispose();
    nextOwner.dispose();
  }
});
