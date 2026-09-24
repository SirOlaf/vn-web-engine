import test from 'node:test';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaProgramResources} from '../dist/engines/buriko/games/aokana/native/program-resources.js';
import {AokanaEngineDialogs} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {AokanaEngineErrors} from '../dist/engines/buriko/games/aokana/native/engine-errors.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaAudioMusicResources} from '../dist/engines/buriko/games/aokana/native/audio/resource-music.js';
import {createGroupA0StreamLoad} from '../dist/engines/buriko/games/aokana/native/group-a0-stream-load.js';
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
import {AokanaAudioResourceStreams} from '../dist/engines/buriko/games/aokana/native/audio/resource-streams.js';

function arc(sample) {
  const bytes = new Uint8Array(144 + 64 + 5000 * 2),
    view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('BURIKO ARC20'));
  view.setUint32(12, 1, true);
  bytes.set(new TextEncoder().encode('VOICE.BW'), 16);
  view.setUint32(116, 10064, true);
  for (const [offset, value] of [
    [0, 64],
    [4, 0x20207762],
    [8, 10000],
    [12, 5000],
    [16, 1000],
    [20, 1],
    [48, 1],
  ])
    view.setUint32(144 + offset, value, true);
  for (let i = 0; i < 5000; i++) view.setInt16(208 + i * 2, sample, true);
  return bytes;
}
test('A0:10 loads actual BP name through music roots into an initialized PCM speaker', async () => {
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
  await backing.commit([{kind: 'write', path: '/game/loose.bw', data: arc(16384).slice(144)}]);
  const mounted = new AokanaMountedFileMetadata(backing, {
    records: ['loose.bw'].map((name) => ({
      path: `/game/${name}`,
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
  const streams = new AokanaAudioResourceStreams(channels, cache, files),
    encode = (s) => files.text.encodeWide(s, 1),
    dialogs = new AokanaEngineDialogs(),
    errors = new AokanaEngineErrors(files, dialogs, encode('C:\\game\\'), encode('C:\\game\\')),
    resources = new AokanaProgramResources(
      files,
      {
        nativeFileRoot: 'C:\\game\\',
        primaryRoot: encode('C:\\game\\'),
        secondaryRoot: Uint8Array.of(0),
        secondaryMediaPath: '',
        searchDirectoriesEnabled: 0,
        searchDirectories: [],
        retryTitle: Uint8Array.of(0),
        retryMessage: Uint8Array.of(0),
        quitConfirmation: Uint8Array.of(0),
      },
      dialogs,
      errors,
      new AokanaDistributedProcessing(new AokanaDistributedAllocator(1), 1),
    ),
    music = new AokanaAudioMusicResources(resources, streams),
    memory = new AokanaBpMemory(new Uint8Array(256)),
    thread = new AokanaBpThread({id: 1, operandCapacity: 8, moduleCapacity: 0, frameCapacity: 0}),
    [slot] = createGroupA0StreamLoad(music, errors);
  memory.globalMemory.set(encode('loose.bw'), 16);
  try {
    await channels.initializeMasters();
    for (const value of [0, 16, 128]) push32(thread, value);
    assert.equal(slot.primary, 0xa0);
    assert.equal(slot.secondary, 0x10);
    assert.equal(slot.nativeAddress, 0x1400e5d00);
    assert.equal(await slot.execute({thread, memory}), 0);
    assert.equal(thread.stackIndex, 0);
    assert.equal(channels.section.depth, 0);
    assert.equal(channels.stream[0].active, 1);
    assert.equal(channels.stream[0].levels.volume.current, 128);
    assert.equal(await channels.stream[0].speaker.start(0), 0);
    assert.deepEqual([...backend.buffers[0].render(8)[0]], Array(8).fill(0.5));
    assert.deepEqual([...backend.buffers[0].render(8)[1]], Array(8).fill(0.5));
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
