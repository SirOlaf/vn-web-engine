import test from 'node:test';
import {BurikoProgramResources} from '../dist/engines/buriko/native/program-resources.js';
import {BurikoEngineDialogs} from '../dist/engines/buriko/native/engine-dialogs.js';
import {BurikoEngineErrors} from '../dist/engines/buriko/native/engine-errors.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoAudioMusicResources} from '../dist/engines/buriko/native/audio/resource-music.js';
import {BurikoAudioLoaderQueues} from '../dist/engines/buriko/native/audio/loader-queues.js';
import {BurikoAudioStaticResources} from '../dist/engines/buriko/native/audio/resource-static.js';
import {BurikoResourceLoadingState} from '../dist/engines/buriko/native/resource-loading.js';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoMountedFileMetadata} from '../dist/engines/buriko/native/file-metadata.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoMountedProgramPaths} from '../dist/engines/buriko/native/program-paths.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoNativeLocks} from '../dist/engines/buriko/native/exclusion-locks.js';
import {BurikoSystemTicks} from '../dist/engines/buriko/native/system-ticks.js';
import {BurikoSpeakerContext} from '../dist/engines/buriko/native/audio/speaker.js';
import {BurikoMemorySpeakerBackend} from '../dist/engines/buriko/native/audio/speaker-backend.js';
import {BurikoAudioChannels} from '../dist/engines/buriko/native/audio/channel-registry.js';
import {BurikoAudioArchiveCache} from '../dist/engines/buriko/native/audio/archive-cache.js';
import {BurikoAudioResourceStreams} from '../dist/engines/buriko/native/audio/resource-streams.js';

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
test('shared loader metadata admits real resource, music and static PCM consumers with one worker actor', async () => {
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
  const backing = new StoredFileSystem(new MemoryStore(), (p) => p.toLowerCase());
  await backing.commit([
    {kind: 'write', path: '/game/loose.bw', data: arc(16384).slice(144)},
    {kind: 'write', path: '/game/document', data: Uint8Array.of(11, 22, 33, 44)},
  ]);
  const mounted = new BurikoMountedFileMetadata(backing, {
    records: ['loose.bw', 'document'].map((name) => ({
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
  const files = new BurikoProgramFiles(
      mounted,
      new BurikoNativeText(),
      new BurikoProgramMedia(),
      new BurikoMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\game'),
    ),
    cache = new BurikoAudioArchiveCache(channels, files);
  cache.rootWide = 'C:\\game\\';
  const streams = new BurikoAudioResourceStreams(channels, cache, files),
    encode = (s) => files.text.encodeWide(s, 1),
    dialogs = new BurikoEngineDialogs(),
    errors = new BurikoEngineErrors(files, dialogs, encode('C:\\game\\'), encode('C:\\game\\')),
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
      new BurikoDistributedProcessing(actors, 1),
    ),
    music = new BurikoAudioMusicResources(resources, streams),
    loading = new BurikoResourceLoadingState(resources),
    statics = new BurikoAudioStaticResources(channels),
    queues = new BurikoAudioLoaderQueues(loading, music, statics),
    output = {bytes: null},
    resourceResult = {value: 99},
    musicResult = {value: 99},
    staticResult = {value: 99},
    staticBytes = arc(-8192).slice(144),
    originalActor = actors.currentActor;
  try {
    await channels.initializeMasters();
    loading.enqueueOwned(output, resourceResult, null, encode('document'), 0, 0, actor);
    queues.enqueueMusic(musicResult, 0, encode('unused.arc'), encode('loose.bw'), 128, 64, actor);
    queues.enqueueStatic(
      staticResult,
      0,
      {bytes: staticBytes, offset: 0},
      0,
      1,
      1,
      new Uint8Array(staticBytes.length).fill(1),
      actor,
    );
    assert.equal(queues.metadata, loading.metadata);
    assert.equal(resourceResult.value, 0);
    assert.equal(musicResult.value, 1);
    assert.equal(staticResult.value, 1);
    assert.equal(await loading.processNext(actor), true);
    assert.deepEqual([...output.bytes], [11, 22, 33, 44]);
    assert.equal(resourceResult.value, 4);
    assert.equal(musicResult.value, 1);
    assert.equal(await queues.processMusic(actor), true);
    assert.equal(musicResult.value, 0);
    assert.equal(staticResult.value, 1);
    assert.equal(await queues.processStatic(actor), true);
    assert.equal(staticResult.value, 0);
    assert.equal(await channels.stream[0].speaker.start(0), 0);
    assert.equal(await channels.startStatic(0, 128, 64), 0);
    assert.deepEqual([...backend.buffers[0].render(8)[0]], Array(8).fill(0.5));
    assert.deepEqual([...backend.buffers[1].render(8)[0]], Array(8).fill(-0.25));
    assert.equal(await statics.duration(0, actor), 5000);
    assert.equal(loading.hasPending, false);
    assert.equal(queues.hasMusic, false);
    assert.equal(queues.hasStatic, false);
    assert.equal(actors.currentActor, originalActor);
    channels.stream[0].speaker.checkWorker();
  } finally {
    await channels.disposeChannels();
    resources.mainProcessing.dispose();
    await channels.section.enter(actor);
    try {
      cache.dispose(actor);
    } finally {
      channels.section.leave(actor);
    }
  }
});
