import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpDiagnostics} from '../dist/engines/buriko/games/aokana/native/diagnostics.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaProcedureState} from '../dist/engines/buriko/games/aokana/native/procedure.js';
import {AokanaLoadSoundProcess} from '../dist/engines/buriko/games/aokana/native/load-sound-process.js';
import {AokanaProgramResources} from '../dist/engines/buriko/games/aokana/native/program-resources.js';
import {AokanaResourceLoadingState} from '../dist/engines/buriko/games/aokana/native/resource-loading.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaMountedFileMetadata} from '../dist/engines/buriko/games/aokana/native/file-metadata.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {AokanaEngineDialogs} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {AokanaEngineErrors} from '../dist/engines/buriko/games/aokana/native/engine-errors.js';
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
import {AokanaAudioStaticResources} from '../dist/engines/buriko/games/aokana/native/audio/resource-static.js';
import {AokanaAudioLoaderQueues} from '../dist/engines/buriko/games/aokana/native/audio/loader-queues.js';
import {createGroupA0StaticPlay} from '../dist/engines/buriko/games/aokana/native/group-a0-static-play.js';

function pcm() {
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
  [0, 8192, 0, -8192].forEach((value, index) => view.setInt16(64 + index * 2, value, true));
  return bytes;
}

test('load-sound process owns the resource until static registration completes through actual queues', async () => {
  const actor = {},
    actors = new AokanaDistributedAllocator(1),
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
  const backing = new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase());
  await backing.commit([{kind: 'write', path: '/game/voice.bw', data: pcm()}]);
  const mounted = new AokanaMountedFileMetadata(backing, {
    records: [
      {
        path: '/game/voice.bw',
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
  });
  const files = new AokanaProgramFiles(
      mounted,
      new AokanaNativeText(),
      new AokanaProgramMedia(),
      new AokanaMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\game'),
    ),
    encode = (value) => files.text.encodeWide(value, 1),
    dialogs = new AokanaEngineDialogs(),
    errors = new AokanaEngineErrors(files, dialogs, encode('C:\\game\\'), encode('C:\\game\\')),
    processing = new AokanaDistributedProcessing(actors, 1),
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
      processing,
    ),
    loading = new AokanaResourceLoadingState(resources),
    cache = new AokanaAudioArchiveCache(channels, files),
    streams = new AokanaAudioResourceStreams(channels, cache, files),
    music = new AokanaAudioMusicResources(resources, streams),
    statics = new AokanaAudioStaticResources(channels),
    queues = new AokanaAudioLoaderQueues(loading, music, statics),
    thread = new AokanaBpThread({id: 1, operandCapacity: 8, moduleCapacity: 2, frameCapacity: 0}),
    context = {
      thread,
      actor,
      memory: new AokanaBpMemory(new Uint8Array(16)),
      diagnostics: new AokanaBpDiagnostics(() => {}),
    };
  let process;
  try {
    await channels.initializeMasters();
    process = await AokanaLoadSoundProcess.create(
      context,
      new AokanaProcedureState(),
      new AokanaNativeClock(() => 0),
      loading,
      queues,
      0,
      0,
      1,
      1,
      null,
      {bytes: encode('VOICE.BW'), offset: 0},
    );
    assert.equal(loading.activeProcedures, 1);
    assert.equal(loading.hasPending, true);
    assert.equal(queues.hasStatic, false);
    assert.equal(await process.poll(), 0);
    assert.equal(await loading.processNext(actor), true);
    assert.equal(process.result.value, 72);
    assert.deepEqual([...process.name], [...encode('voice.bw')]);
    assert.equal(await process.poll(), 0);
    assert.equal(process.staticResult.value, 1);
    assert.equal(queues.hasStatic, true);
    assert.equal(await process.poll(), 0);
    assert.equal(await queues.processStatic(actor), true);
    assert.equal(process.staticResult.value, 0);
    assert.equal(await process.poll(), 1);
    process.dispose();
    process = undefined;
    assert.equal(loading.activeProcedures, 0);
    assert.equal(loading.hasPending, false);
    assert.equal(queues.hasStatic, false);

    const [play] = createGroupA0StaticPlay(statics, errors);
    for (const value of [0, 128, 64]) push32(thread, value);
    assert.equal(await play.execute(context), 0);
    assert.equal(pop32(thread), 4);
    const output = backend.buffers[0].render(4);
    assert.deepEqual([...output[0]], [0, 0.25, 0, -0.25]);
    assert.deepEqual([...output[1]], [0, 0.25, 0, -0.25]);
    assert.equal(await channels.releaseStatic(0), 0);
  } finally {
    process?.dispose();
    await channels.disposeChannels();
    processing.dispose();
    await channels.section.enter(actor);
    try {
      cache.dispose(actor);
    } finally {
      channels.section.leave(actor);
    }
  }
});
