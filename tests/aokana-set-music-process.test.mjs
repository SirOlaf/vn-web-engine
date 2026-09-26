import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpScheduler} from '../dist/engines/buriko/games/aokana/bp/scheduler.js';
import {AokanaBpDiagnostics} from '../dist/engines/buriko/games/aokana/native/diagnostics.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaProcedureState} from '../dist/engines/buriko/games/aokana/native/procedure.js';
import {AokanaSetMusicProcess} from '../dist/engines/buriko/games/aokana/native/set-music-process.js';
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

test('DCProcSetMusic copies inline names and completes through actual music FIFO and speaker', async () => {
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
    staticResources = new AokanaAudioStaticResources(channels),
    audio = new AokanaAudioLoaderQueues(loading, music, staticResources),
    scripts = new AokanaScriptFiles(
      files,
      actors,
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    ),
    worker = new AokanaSharedLoaderWorker(loading, audio, scripts),
    root = new AokanaBpThread({id: 0, operandCapacity: 8, moduleCapacity: 0, frameCapacity: 0}),
    thread = new AokanaBpThread({id: 1, operandCapacity: 8, moduleCapacity: 2, frameCapacity: 0}),
    scheduler = new AokanaBpScheduler(root, () => 1),
    node = scheduler.append(thread),
    memory = new AokanaBpMemory(new Uint8Array(0x300)),
    context = {thread, actor: caller, memory, diagnostics: new AokanaBpDiagnostics(() => {})};
  scheduler.attachSharedLoaderWorker(worker);
  memory.globalMemory.set(encode('unused.arc'), 0x100);
  memory.globalMemory.set(encode('loose.bw'), 0x180);
  const process = new AokanaSetMusicProcess(
    context,
    new AokanaProcedureState(),
    new AokanaNativeClock(() => 0),
    loading,
    audio,
    0,
    memory.resolve(thread, 0x100),
    memory.resolve(thread, 0x180),
    128,
    64,
  );
  try {
    await channels.initializeMasters();
    worker.start();
    assert.equal(process.archive.length, 780);
    assert.equal(process.name.length, 780);
    assert.equal(Object.hasOwn(process.result, 'value'), false);
    assert.equal(loading.activeProcedures, 1);
    memory.globalMemory.fill(0x58, 0x100, 0x190);
    assert.deepEqual([...process.archive.subarray(0, 11)], [...encode('unused.arc')]);
    assert.deepEqual([...process.name.subarray(0, 9)], [...encode('loose.bw')]);
    node.installProcess(process);
    for (let attempt = 0; attempt < 100 && node.process !== null; attempt++) await scheduler.run();
    assert.equal(node.process, null);
    assert.equal(process.result.value, 0);
    assert.equal(loading.activeProcedures, 0);
    assert.equal(audio.hasMusic, false);
    assert.equal(await channels.stream[0].speaker.start(0), 0);
    const output = backend.buffers[0].render(8);
    assert.deepEqual([...output[0]], Array(8).fill(0.5));
    assert.deepEqual([...output[1]], Array(8).fill(0.5));
    channels.stream[0].speaker.checkWorker();
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
