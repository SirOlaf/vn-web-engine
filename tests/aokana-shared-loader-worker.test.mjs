import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeLocks} from '../dist/engines/buriko/games/aokana/native/exclusion-locks.js';
import {AokanaSpeakerContext} from '../dist/engines/buriko/games/aokana/native/audio/speaker.js';
import {AokanaMemorySpeakerBackend} from '../dist/engines/buriko/games/aokana/native/audio/speaker-backend.js';
import {AokanaAudioChannels} from '../dist/engines/buriko/games/aokana/native/audio/channel-registry.js';
import {AokanaAudioArchiveCache} from '../dist/engines/buriko/games/aokana/native/audio/archive-cache.js';
import {AokanaAudioResourceStreams} from '../dist/engines/buriko/games/aokana/native/audio/resource-streams.js';
import {AokanaAudioMusicResources} from '../dist/engines/buriko/games/aokana/native/audio/resource-music.js';
import {AokanaAudioStaticResources} from '../dist/engines/buriko/games/aokana/native/audio/resource-static.js';
import {AokanaAudioLoaderQueues} from '../dist/engines/buriko/games/aokana/native/audio/loader-queues.js';
import {AokanaSystemTicks} from '../dist/engines/buriko/games/aokana/native/system-ticks.js';
import {AokanaMountedFileMetadata} from '../dist/engines/buriko/games/aokana/native/file-metadata.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaEngineDialogs} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {AokanaEngineErrors} from '../dist/engines/buriko/games/aokana/native/engine-errors.js';
import {AokanaProgramResources} from '../dist/engines/buriko/games/aokana/native/program-resources.js';
import {AokanaResourceLoadingState} from '../dist/engines/buriko/games/aokana/native/resource-loading.js';
import {AokanaScriptFiles} from '../dist/engines/buriko/games/aokana/native/script-files.js';
import {AokanaSharedLoaderWorker} from '../dist/engines/buriko/games/aokana/native/shared-loader-worker.js';
import {AokanaBpScheduler} from '../dist/engines/buriko/games/aokana/bp/scheduler.js';
import {AokanaBpThread} from '../dist/engines/buriko/games/aokana/bp/state.js';

function wave(sample) {
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
  for (let i = 0; i < 5000; i++) view.setInt16(64 + i * 2, sample, true);
  return bytes;
}

test('one shared loader actor restarts priority after each real resource, music, static and script job', async () => {
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
  await backing.commit([
    {kind: 'write', path: '/game/loose.bw', data: wave(16384)},
    {kind: 'write', path: '/game/document', data: Uint8Array.of(11, 22, 33, 44)},
  ]);
  const mounted = new AokanaMountedFileMetadata(backing, {
      records: ['loose.bw', 'document'].map((name) => ({
        path: `/game/${name}`,
        kind: 'file',
        attributes: 32,
        creationTime: null,
        accessTime: null,
        writeTime: 123n,
      })),
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
    cache = new AokanaAudioArchiveCache(channels, files);
  cache.rootWide = 'C:\\game\\';
  const streams = new AokanaAudioResourceStreams(channels, cache, files),
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
      new AokanaDistributedProcessing(actors, 1),
    ),
    loading = new AokanaResourceLoadingState(resources),
    music = new AokanaAudioMusicResources(resources, streams),
    statics = new AokanaAudioStaticResources(channels),
    audio = new AokanaAudioLoaderQueues(loading, music, statics),
    scripts = new AokanaScriptFiles(
      files,
      actors,
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    ),
    worker = new AokanaSharedLoaderWorker(loading, audio, scripts),
    first = {bytes: null},
    second = {bytes: null},
    firstResult = {value: 99},
    secondResult = {value: 99},
    musicResult = {value: 99},
    staticResult = {value: 99},
    staticBytes = wave(-8192),
    completion = {bytes: new Uint8Array(4), offset: 0},
    handle = {bytes: new Uint8Array(4), offset: 0},
    scriptBuffer = {bytes: new Uint8Array(4), offset: 0};
  try {
    await channels.initializeMasters();
    const originalScriptStep = scripts.processFirst.bind(scripts);
    scripts.processFirst = (actor) => {
      assert.equal(actor, worker.actor);
      return originalScriptStep(actor);
    };
    worker.start({automatic: false});
    assert.equal(
      await scripts.open(handle, {bytes: encode('C:\\game\\document'), offset: 0}, 0, caller),
      0,
    );
    const id = new DataView(handle.bytes.buffer).getUint32(0, true);
    assert.equal(await scripts.queueTransfer(completion, id, scriptBuffer, 4, caller), 0);
    loading.enqueueOwned(first, firstResult, null, encode('document'), 0, 0, caller);
    audio.enqueueMusic(musicResult, 0, encode('unused.arc'), encode('loose.bw'), 128, 64, caller);
    audio.enqueueStatic(
      staticResult,
      0,
      {bytes: staticBytes, offset: 0},
      0,
      1,
      1,
      new Uint8Array(staticBytes.length).fill(1),
      caller,
    );
    assert.equal(await worker.processOne(), 'resource');
    assert.deepEqual([...first.bytes], [11, 22, 33, 44]);
    assert.equal(musicResult.value, 1);
    loading.enqueueOwned(second, secondResult, null, encode('document'), 0, 0, caller);
    assert.equal(await worker.processOne(), 'resource');
    assert.deepEqual([...second.bytes], [11, 22, 33, 44]);
    assert.equal(await worker.processOne(), 'music');
    assert.equal(musicResult.value, 0);
    assert.equal(staticResult.value, 1);
    assert.equal(await worker.processOne(), 'static');
    assert.equal(staticResult.value, 0);
    assert.equal(await worker.processOne(), 'script');
    assert.deepEqual([...scriptBuffer.bytes], [11, 22, 33, 44]);
    assert.equal(new DataView(completion.bytes.buffer).getUint32(0, true), 4);
    assert.equal(await channels.stream[0].speaker.start(0), 0);
    assert.equal(await channels.startStatic(0, 128, 64), 0);
    assert.deepEqual([...backend.buffers[0].render(8)[0]], Array(8).fill(0.5));
    assert.deepEqual([...backend.buffers[1].render(8)[0]], Array(8).fill(-0.25));
    assert.equal(actors.currentActor === worker.actor, false);
    worker.resumeAutomatic();
    await worker.shutdown(caller);
    await worker.join();
    assert.equal(scripts.find(id), null);
    assert.equal(worker.isRunning, false);
    worker.start();
    const automatic = {bytes: null},
      automaticResult = {value: 99};
    loading.enqueueOwned(automatic, automaticResult, null, encode('document'), 0, 0, caller);
    const root = new AokanaBpThread({
      id: 0,
      operandCapacity: 16,
      moduleCapacity: 256,
      frameCapacity: 0,
    });
    const scheduler = new AokanaBpScheduler(root, () => 0);
    scheduler.attachSharedLoaderWorker(worker);
    assert.equal(await scheduler.run(), 0);
    for (let attempt = 0; automaticResult.value !== 4 && attempt < 50; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.deepEqual([...automatic.bytes], [11, 22, 33, 44]);
    await worker.shutdown(caller);
    await worker.join();

    worker.start();
    const discarded = {bytes: null},
      discardedResult = {value: 99},
      retainedMusic = {value: 99},
      discardedStatic = {value: 99};
    loading.enqueueOwned(discarded, discardedResult, null, encode('document'), 0, 0, caller);
    audio.enqueueMusic(retainedMusic, 0, encode('unused.arc'), encode('loose.bw'), 128, 64, caller);
    audio.enqueueStatic(
      discardedStatic,
      0,
      {bytes: staticBytes, offset: 0},
      0,
      1,
      1,
      new Uint8Array(staticBytes.length).fill(1),
      caller,
    );
    await worker.stop();
    await worker.join();
    assert.equal(loading.hasPending, false);
    assert.equal(audio.hasStatic, false);
    assert.equal(audio.hasMusic, true);
    assert.equal(discardedResult.value, 0);
    assert.equal(discardedStatic.value, 1);
    assert.equal(retainedMusic.value, 1);
    channels.stream[0].speaker.checkWorker();
  } finally {
    if (worker.isRunning) await worker.shutdown(caller);
    await channels.disposeChannels();
    resources.mainProcessing.dispose();
    await channels.section.enter(caller);
    try {
      cache.dispose(caller);
    } finally {
      channels.section.leave(caller);
    }
  }
});
