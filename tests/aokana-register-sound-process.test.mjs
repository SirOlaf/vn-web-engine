import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpDiagnostics} from '../dist/engines/buriko/games/aokana/native/diagnostics.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaProcedureState} from '../dist/engines/buriko/games/aokana/native/procedure.js';
import {AokanaRegisterSoundProcess} from '../dist/engines/buriko/games/aokana/native/register-sound-process.js';
import {AokanaProgramResources} from '../dist/engines/buriko/games/aokana/native/program-resources.js';
import {AokanaResourceLoadingState} from '../dist/engines/buriko/games/aokana/native/resource-loading.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
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

test('direct sound process queues borrowed PCM, completes through the real static worker and plays through A0:24', async () => {
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
  const text = new AokanaNativeText(),
    encode = (value) => text.encodeWide(value, 1),
    files = new AokanaProgramFiles(
      new StoredFileSystem(new MemoryStore()),
      text,
      new AokanaProgramMedia(),
    ),
    dialogs = new AokanaEngineDialogs(),
    errors = new AokanaEngineErrors(files, dialogs, encode('/save/'), encode('/')),
    processing = new AokanaDistributedProcessing(actors, 1),
    resources = new AokanaProgramResources(
      files,
      {
        nativeFileRoot: 'C:\\',
        primaryRoot: encode('C:\\'),
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
    sourceBytes = new Uint8Array(80),
    source = {bytes: sourceBytes, offset: 8},
    view = new DataView(sourceBytes.buffer),
    process = new AokanaRegisterSoundProcess(
      {
        thread,
        actor,
        memory: new AokanaBpMemory(new Uint8Array(16)),
        diagnostics: new AokanaBpDiagnostics(() => {}),
      },
      new AokanaProcedureState(),
      new AokanaNativeClock(() => 0),
      loading,
      queues,
      0,
      source,
      0,
      1,
      1,
      new Uint8Array(sourceBytes.length).fill(1),
    );
  for (const [offset, value] of [
    [0, 64],
    [4, 0x20207762],
    [8, 8],
    [12, 4],
    [16, 1000],
    [20, 1],
    [48, 1],
  ])
    view.setUint32(source.offset + offset, value, true);
  [0, 8192, 0, -8192].forEach((value, index) =>
    view.setInt16(source.offset + 64 + index * 2, value, true),
  );
  try {
    await channels.initializeMasters();
    assert.equal(loading.activeProcedures, 1);
    assert.equal(Object.hasOwn(process.result, 'value'), false);
    source.offset = 0;
    assert.equal(process.poll(), 0);
    assert.equal(process.result.value, 1);
    assert.equal(queues.hasStatic, true);
    assert.equal(process.poll(), 0);
    // The process copied the descriptor, while the queue still borrows the caller's backing.
    view.setInt16(8 + 64 + 2, 16384, true);
    view.setInt16(8 + 64 + 6, -16384, true);
    assert.equal(await queues.processStatic(actor), true);
    assert.equal(process.result.value, 0);
    assert.equal(process.poll(), 1);
    process.dispose();
    assert.equal(loading.activeProcedures, 0);
    assert.equal(queues.hasStatic, false);
    assert.equal(sourceBytes.length, 80);

    const [play] = createGroupA0StaticPlay(statics, errors);
    for (const value of [0, 128, 64]) push32(thread, value);
    assert.equal(
      await play.execute({thread, actor, diagnostics: new AokanaBpDiagnostics(() => {})}),
      0,
    );
    assert.equal(pop32(thread), 4);
    const output = backend.buffers[0].render(4);
    assert.deepEqual([...output[0]], [0, 0.5, 0, -0.5]);
    assert.deepEqual([...output[1]], [0, 0.5, 0, -0.5]);
    assert.equal(await channels.releaseStatic(0), 0);
  } finally {
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
