import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpScheduler} from '../dist/engines/buriko/bp/scheduler.js';
import {BurikoBpDiagnostics} from '../dist/engines/buriko/native/diagnostics.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoProcedureState} from '../dist/engines/buriko/native/procedure.js';
import {BurikoSetMusicProcess} from '../dist/engines/buriko/native/set-music-process.js';
import {createGroupA0MusicLoad} from '../dist/engines/buriko/native/group-a0-music-load.js';
import {BurikoVmControlState} from '../dist/engines/buriko/native/group-80-threads.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoMountedFileMetadata} from '../dist/engines/buriko/native/file-metadata.js';
import {BurikoMountedProgramPaths} from '../dist/engines/buriko/native/program-paths.js';
import {BurikoEngineDialogs} from '../dist/engines/buriko/native/engine-dialogs.js';
import {BurikoEngineErrors} from '../dist/engines/buriko/native/engine-errors.js';
import {BurikoProgramResources} from '../dist/engines/buriko/native/program-resources.js';
import {BurikoResourceLoadingState} from '../dist/engines/buriko/native/resource-loading.js';
import {BurikoScriptFiles} from '../dist/engines/buriko/native/script-files.js';
import {BurikoSharedLoaderWorker} from '../dist/engines/buriko/native/shared-loader-worker.js';
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

test('A0:11 runs synchronous and queued music through actual mounted PCM and speakers', async () => {
  const caller = {},
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
  const backing = new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase());
  await backing.commit([{kind: 'write', path: '/game/loose.bw', data: pcm()}]);
  const mounted = new BurikoMountedFileMetadata(backing, {
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
    files = new BurikoProgramFiles(
      mounted,
      new BurikoNativeText(),
      new BurikoProgramMedia(),
      new BurikoMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\game'),
    ),
    encode = (value) => files.text.encodeWide(value, 1),
    dialogs = new BurikoEngineDialogs(),
    errors = new BurikoEngineErrors(files, dialogs, encode('C:\\game\\'), encode('C:\\game\\')),
    processing = new BurikoDistributedProcessing(actors, 1),
    resources = new BurikoProgramResources(
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
    loading = new BurikoResourceLoadingState(resources),
    cache = new BurikoAudioArchiveCache(channels, files),
    streams = new BurikoAudioResourceStreams(channels, cache, files),
    music = new BurikoAudioMusicResources(resources, streams),
    staticResources = new BurikoAudioStaticResources(channels),
    audio = new BurikoAudioLoaderQueues(loading, music, staticResources),
    scripts = new BurikoScriptFiles(
      files,
      actors,
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    ),
    worker = new BurikoSharedLoaderWorker(loading, audio, scripts),
    root = new BurikoBpThread({id: 0, operandCapacity: 8, moduleCapacity: 0, frameCapacity: 0}),
    thread = new BurikoBpThread({id: 1, operandCapacity: 8, moduleCapacity: 2, frameCapacity: 0}),
    scheduler = new BurikoBpScheduler(root, () => 1),
    node = scheduler.append(thread),
    memory = new BurikoBpMemory(new Uint8Array(0x300)),
    context = {thread, actor: caller, memory, diagnostics: new BurikoBpDiagnostics(() => {})},
    control = new BurikoVmControlState(),
    [slot] = createGroupA0MusicLoad(
      worker,
      scheduler,
      new BurikoProcedureState(),
      new BurikoNativeClock(() => 0),
      control,
    );
  memory.globalMemory.set(encode('unused.arc'), 0x100);
  memory.globalMemory.set(encode('loose.bw'), 0x180);
  const invoke = async (channel) => {
    for (const value of [channel, 0x100, 0x180, 128, 64]) push32(thread, value);
    const result = await slot.execute(context);
    assert.equal(thread.stackIndex, 0);
    return result;
  };
  try {
    await channels.initializeMasters();
    assert.equal(slot.nativeAddress, 0x1400e5b80);
    assert.equal(slot.primary, 0xa0);
    assert.equal(slot.secondary, 0x11);
    assert.equal(await invoke(0), 0);
    assert.equal(control.asynchronousResourceLoads, 0);
    assert.equal(node.process, null);
    assert.equal(loading.activeProcedures, 0);
    assert.equal(await channels.stream[0].speaker.start(0), 0);
    const synchronous = backend.buffers[0].render(8);
    assert.deepEqual([...synchronous[0]], Array(8).fill(0.5));
    assert.deepEqual([...synchronous[1]], Array(8).fill(0.5));
    channels.stream[0].speaker.checkWorker();

    control.asynchronousResourceLoads = 1;
    assert.equal(await invoke(1), 2);
    assert.equal(control.asynchronousResourceLoads, 0);
    assert.ok(node.process instanceof BurikoSetMusicProcess);
    assert.equal(loading.activeProcedures, 1);
    node.installProcess(null);
    assert.equal(loading.activeProcedures, 0);

    worker.start();
    control.asynchronousResourceLoads = 1;
    assert.equal(await invoke(1), 2);
    assert.equal(control.asynchronousResourceLoads, 0);
    assert.ok(node.process instanceof BurikoSetMusicProcess);
    assert.equal(node.process.archive.length, 780);
    assert.equal(node.process.name.length, 780);
    assert.equal(Object.hasOwn(node.process.result, 'value'), false);
    assert.equal(loading.activeProcedures, 1);
    memory.globalMemory.fill(0x58, 0x100, 0x190);
    assert.deepEqual([...node.process.archive.subarray(0, 11)], [...encode('unused.arc')]);
    assert.deepEqual([...node.process.name.subarray(0, 9)], [...encode('loose.bw')]);
    const process = node.process;
    for (let attempt = 0; attempt < 100 && node.process !== null; attempt++) await scheduler.run();
    assert.equal(node.process, null);
    assert.equal(process.result.value, 0);
    assert.equal(loading.activeProcedures, 0);
    assert.equal(audio.hasMusic, false);
    assert.equal(await channels.stream[1].speaker.start(0), 0);
    const asynchronous = backend.buffers[1].render(8);
    assert.deepEqual([...asynchronous[0]], Array(8).fill(0.5));
    assert.deepEqual([...asynchronous[1]], Array(8).fill(0.5));
    channels.stream[1].speaker.checkWorker();
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
