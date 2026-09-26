import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpScheduler} from '../dist/engines/buriko/games/aokana/bp/scheduler.js';
import {AokanaBpDiagnostics} from '../dist/engines/buriko/games/aokana/native/diagnostics.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaProcedureState} from '../dist/engines/buriko/games/aokana/native/procedure.js';
import {AokanaLoadSoundProcess} from '../dist/engines/buriko/games/aokana/native/load-sound-process.js';
import {AokanaRegisterSoundProcess} from '../dist/engines/buriko/games/aokana/native/register-sound-process.js';
import {createGroupA0SoundProcesses} from '../dist/engines/buriko/games/aokana/native/group-a0-sound-processes.js';
import {createGroupA0StaticPlay} from '../dist/engines/buriko/games/aokana/native/group-a0-static-play.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaMountedFileMetadata} from '../dist/engines/buriko/games/aokana/native/file-metadata.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {AokanaEngineDialogs} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {AokanaEngineErrors} from '../dist/engines/buriko/games/aokana/native/engine-errors.js';
import {AokanaProgramResources} from '../dist/engines/buriko/games/aokana/native/program-resources.js';
import {AokanaResourceLoadingState} from '../dist/engines/buriko/games/aokana/native/resource-loading.js';
import {AokanaScriptFiles} from '../dist/engines/buriko/games/aokana/native/script-files.js';
import {AokanaSharedLoaderWorker} from '../dist/engines/buriko/games/aokana/native/shared-loader-worker.js';
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

function pcm(sample) {
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
  [0, sample, 0, -sample].forEach((value, index) => view.setInt16(64 + index * 2, value, true));
  return bytes;
}

test('A0:21 and A0:28 use one automatically scheduled loader and produce literal PCM through A0:24', async () => {
  const caller = {},
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
  await backing.commit([{kind: 'write', path: '/game/voice.bw', data: pcm(8192)}]);
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
    audio = new AokanaAudioLoaderQueues(loading, music, statics),
    scripts = new AokanaScriptFiles(
      files,
      actors,
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    ),
    worker = new AokanaSharedLoaderWorker(loading, audio, scripts),
    root = new AokanaBpThread({id: 0, operandCapacity: 8, moduleCapacity: 0, frameCapacity: 0}),
    thread = new AokanaBpThread({id: 1, operandCapacity: 16, moduleCapacity: 2, frameCapacity: 0}),
    scheduler = new AokanaBpScheduler(root, () => 1),
    node = scheduler.append(thread),
    memory = new AokanaBpMemory(new Uint8Array(0x400)),
    context = {thread, actor: caller, memory, diagnostics: new AokanaBpDiagnostics(() => {})},
    slots = createGroupA0SoundProcesses(
      worker,
      scheduler,
      new AokanaProcedureState(),
      new AokanaNativeClock(() => 0),
    ),
    play = createGroupA0StaticPlay(statics, errors)[0];
  const awaitCompletion = async () => {
    for (let attempt = 0; attempt < 100 && node.process !== null; attempt++) await scheduler.run();
    assert.equal(node.process, null);
    assert.equal(loading.activeProcedures, 0);
  };
  const playSound = async (channel, expected) => {
    for (const value of [channel, 128, 64]) push32(thread, value);
    assert.equal(await play.execute(context), 0);
    assert.equal(pop32(thread), 4);
    const output = backend.buffers.at(-1).render(4);
    assert.deepEqual([...output[0]], expected);
    assert.deepEqual([...output[1]], expected);
    assert.equal(await channels.releaseStatic(channel), 0);
  };
  try {
    await channels.initializeMasters();
    worker.start();
    assert.deepEqual(
      slots.map((slot) => slot.secondary),
      [0x20, 0x21, 0x23, 0x27, 0x28],
    );
    memory.globalMemory.set(encode('VOICE.BW'), 0x100);
    for (const value of [0, 0, 0x100, 0, 65536]) push32(thread, value);
    assert.equal(await slots[1].execute(context), 2);
    assert.ok(node.process instanceof AokanaLoadSoundProcess);
    assert.equal(loading.activeProcedures, 1);
    await awaitCompletion();
    assert.equal(loading.hasPending, false);
    assert.equal(audio.hasStatic, false);
    await playSound(0, [0, 0.25, 0, -0.25]);

    memory.globalMemory.set(pcm(16384), 0x200);
    for (const value of [1, 0x200, 0, 65536, 65536]) push32(thread, value);
    assert.equal(slots[4].execute(context), 2);
    assert.ok(node.process instanceof AokanaRegisterSoundProcess);
    assert.equal(loading.activeProcedures, 1);
    await awaitCompletion();
    assert.equal(audio.hasStatic, false);
    await playSound(1, [0, 0.5, 0, -0.5]);
    assert.equal(thread.stackIndex, 0);
    assert.equal(actors.currentActor === worker.actor, false);
  } finally {
    if (worker.isRunning) {
      await worker.shutdown(caller);
      await worker.join();
    }
    node.installProcess(null);
    await channels.disposeChannels();
    processing.dispose();
    await channels.section.enter(caller);
    try {
      cache.dispose(caller);
    } finally {
      channels.section.leave(caller);
    }
  }
});
