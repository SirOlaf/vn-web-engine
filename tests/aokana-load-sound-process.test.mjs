import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpDiagnostics} from '../dist/engines/buriko/native/diagnostics.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoProcedureState} from '../dist/engines/buriko/native/procedure.js';
import {BurikoLoadSoundProcess} from '../dist/engines/buriko/native/load-sound-process.js';
import {BurikoProgramResources} from '../dist/engines/buriko/native/program-resources.js';
import {BurikoResourceLoadingState} from '../dist/engines/buriko/native/resource-loading.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoMountedFileMetadata} from '../dist/engines/buriko/native/file-metadata.js';
import {BurikoMountedProgramPaths} from '../dist/engines/buriko/native/program-paths.js';
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
  await backing.commit([{kind: 'write', path: '/game/voice.bw', data: pcm()}]);
  const mounted = new BurikoMountedFileMetadata(backing, {
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
  const files = new BurikoProgramFiles(
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
    statics = new BurikoAudioStaticResources(channels),
    queues = new BurikoAudioLoaderQueues(loading, music, statics),
    thread = new BurikoBpThread({id: 1, operandCapacity: 8, moduleCapacity: 2, frameCapacity: 0}),
    context = {
      thread,
      actor,
      memory: new BurikoBpMemory(new Uint8Array(16)),
      diagnostics: new BurikoBpDiagnostics(() => {}),
    };
  let process;
  try {
    await channels.initializeMasters();
    process = await BurikoLoadSoundProcess.create(
      context,
      new BurikoProcedureState(),
      new BurikoNativeClock(() => 0),
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
