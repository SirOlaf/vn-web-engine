import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaMountedFileMetadata} from '../dist/engines/buriko/games/aokana/native/file-metadata.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaEngineDialogs} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {AokanaEngineErrors} from '../dist/engines/buriko/games/aokana/native/engine-errors.js';
import {AokanaProgramResources} from '../dist/engines/buriko/games/aokana/native/program-resources.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeLocks} from '../dist/engines/buriko/games/aokana/native/exclusion-locks.js';
import {AokanaSystemTicks} from '../dist/engines/buriko/games/aokana/native/system-ticks.js';
import {AokanaSpeakerContext} from '../dist/engines/buriko/games/aokana/native/audio/speaker.js';
import {AokanaMemorySpeakerBackend} from '../dist/engines/buriko/games/aokana/native/audio/speaker-backend.js';
import {AokanaAudioChannels} from '../dist/engines/buriko/games/aokana/native/audio/channel-registry.js';
import {AokanaAudioArchiveCache} from '../dist/engines/buriko/games/aokana/native/audio/archive-cache.js';
import {AokanaAudioResourceStreams} from '../dist/engines/buriko/games/aokana/native/audio/resource-streams.js';
import {AokanaAudioMusicResources} from '../dist/engines/buriko/games/aokana/native/audio/resource-music.js';
import {createGroupA0PairedMusicLoad} from '../dist/engines/buriko/games/aokana/native/group-a0-paired-music-load.js';

function pcm() {
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
  for (let index = 0; index < 5000; index++) view.setInt16(64 + index * 2, 16384, true);
  return bytes;
}

test('A0:12 same-name pair uses one mounted PCM stream and its raw loop mode', async () => {
  const actor = {},
    actors = {currentActor: actor},
    locks = new AokanaNativeLocks(actors);
  locks.initializeEngine();
  const channels = new AokanaAudioChannels(
    new AokanaSpeakerContext(new AokanaMemorySpeakerBackend(1000)),
    locks,
    actors,
    new AokanaSystemTicks({now: () => 0}),
    {prefer24Bit: false},
  );
  channels.initialize({});
  channels.activate();
  const backing = new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase());
  await backing.commit([{kind: 'write', path: '/game/loose.bw', data: pcm()}]);
  const mounted = new AokanaMountedFileMetadata(backing, {
      records: [
        {
          path: '/game/loose.bw',
          kind: 'file',
          attributes: 32,
          creationTime: null,
          accessTime: null,
          writeTime: 123n,
        },
      ],
      volumes: [{path: '/', identity: {}, writable: true}],
      canonical: (path) => path.toLowerCase(),
      currentFileTime: () => 123n,
      accessTimePolicy: 'disabled',
    }),
    files = new AokanaProgramFiles(
      mounted,
      new AokanaNativeText(),
      new AokanaProgramMedia(),
      new AokanaMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\game'),
    ),
    encode = (value) => files.text.encodeWide(value, 1),
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
    cache = new AokanaAudioArchiveCache(channels, files),
    streams = new AokanaAudioResourceStreams(channels, cache, files),
    music = new AokanaAudioMusicResources(resources, streams),
    memory = new AokanaBpMemory(new Uint8Array(256)),
    thread = new AokanaBpThread({id: 1, operandCapacity: 8, moduleCapacity: 0, frameCapacity: 0}),
    [slot] = createGroupA0PairedMusicLoad(music, errors);
  cache.rootWide = 'C:\\game\\';
  memory.globalMemory.set(encode('loose.bw'), 0x80);
  try {
    await channels.initializeMasters();
    // Native pop order: pan, volume, raw DWORD, last name, first name, archive, channel.
    for (const value of [0, 0, 0x80, 0x80, 1, 96, 64]) push32(thread, value);
    assert.equal(slot.primary, 0xa0);
    assert.equal(slot.secondary, 0x12);
    assert.equal(slot.nativeAddress, 0x1400e5a50);
    assert.equal(await slot.execute({thread, memory, actor}), 0);
    assert.equal(thread.stackIndex, 0);
    assert.equal(channels.section.depth, 0);
    assert.equal(channels.stream[0].active, 1);
    assert.equal(channels.stream[0].levels.volume.current, 96);
    assert.equal(channels.stream[0].model.wave.loopEnabled, 2);
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
