import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpDiagnostics} from '../dist/engines/buriko/native/diagnostics.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoProcedureState} from '../dist/engines/buriko/native/procedure.js';
import {BurikoRegisterSoundProcess} from '../dist/engines/buriko/native/register-sound-process.js';
import {BurikoProgramResources} from '../dist/engines/buriko/native/program-resources.js';
import {BurikoResourceLoadingState} from '../dist/engines/buriko/native/resource-loading.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoEngineDialogs} from '../dist/engines/buriko/native/engine-dialogs.js';
import {BurikoEngineErrors} from '../dist/engines/buriko/native/engine-errors.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeLocks} from '../dist/engines/buriko/native/exclusion-locks.js';
import {BurikoSystemTicks} from '../dist/engines/buriko/native/system-ticks.js';
import {BurikoSpeakerContext} from '../dist/engines/buriko/native/audio/speaker.js';
import {BurikoMemorySpeakerBackend} from '../dist/engines/buriko/native/audio/speaker-backend.js';
import {BurikoAudioChannels} from '../dist/engines/buriko/native/audio/channel-registry.js';
import {BurikoAudioArchiveCache} from '../dist/engines/buriko/native/audio/archive-cache.js';
import {BurikoAudioResourceStreams} from '../dist/engines/buriko/native/audio/resource-streams.js';
import {BurikoAudioMusicResources} from '../dist/engines/buriko/native/audio/resource-music.js';
import {BurikoAudioStaticResources} from '../dist/engines/buriko/native/audio/resource-static.js';
import {BurikoAudioLoaderQueues} from '../dist/engines/buriko/native/audio/loader-queues.js';
import {createGroupA0StaticPlay} from '../dist/engines/buriko/native/group-a0-static-play.js';

test('direct sound process queues borrowed PCM, completes through the real static worker and plays through A0:24', async () => {
  const actor = {},
    actors = new BurikoDistributedAllocator(1),
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
  const text = new BurikoNativeText(),
    encode = (value) => text.encodeWide(value, 1),
    files = new BurikoProgramFiles(
      new StoredFileSystem(new MemoryStore()),
      text,
      new BurikoProgramMedia(),
    ),
    dialogs = new BurikoEngineDialogs(),
    errors = new BurikoEngineErrors(files, dialogs, encode('/save/'), encode('/')),
    processing = new BurikoDistributedProcessing(actors, 1),
    resources = new BurikoProgramResources(
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
    loading = new BurikoResourceLoadingState(resources),
    cache = new BurikoAudioArchiveCache(channels, files),
    streams = new BurikoAudioResourceStreams(channels, cache, files),
    music = new BurikoAudioMusicResources(resources, streams),
    statics = new BurikoAudioStaticResources(channels),
    queues = new BurikoAudioLoaderQueues(loading, music, statics),
    thread = new BurikoBpThread({id: 1, operandCapacity: 8, moduleCapacity: 2, frameCapacity: 0}),
    sourceBytes = new Uint8Array(80),
    source = {bytes: sourceBytes, offset: 8},
    view = new DataView(sourceBytes.buffer),
    process = new BurikoRegisterSoundProcess(
      {
        thread,
        actor,
        memory: new BurikoBpMemory(new Uint8Array(16)),
        diagnostics: new BurikoBpDiagnostics(() => {}),
      },
      new BurikoProcedureState(),
      new BurikoNativeClock(() => 0),
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
      await play.execute({thread, actor, diagnostics: new BurikoBpDiagnostics(() => {})}),
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
