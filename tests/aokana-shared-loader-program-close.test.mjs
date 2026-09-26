import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoMountedFileMetadata} from '../dist/engines/buriko/native/file-metadata.js';
import {BurikoMountedProgramPaths} from '../dist/engines/buriko/native/program-paths.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoEngineDialogs} from '../dist/engines/buriko/native/engine-dialogs.js';
import {BurikoEngineErrors} from '../dist/engines/buriko/native/engine-errors.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoProgramResources} from '../dist/engines/buriko/native/program-resources.js';
import {BurikoResourceLoadingState} from '../dist/engines/buriko/native/resource-loading.js';
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
import {BurikoScriptFiles} from '../dist/engines/buriko/native/script-files.js';
import {BurikoSharedLoaderWorker} from '../dist/engines/buriko/native/shared-loader-worker.js';

test('per-program script close leaves one mounted loader alive until final stop', async () => {
  const backing = new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase());
  await backing.commit([{kind: 'write', path: '/game/document', data: Uint8Array.of(11, 22, 33)}]);
  const mounted = new BurikoMountedFileMetadata(backing, {
      records: [
        {
          path: '/game/document',
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
    allocator = new BurikoDistributedAllocator(1),
    processing = new BurikoDistributedProcessing(allocator, 1),
    text = new BurikoNativeText(),
    files = new BurikoProgramFiles(
      mounted,
      text,
      new BurikoProgramMedia(),
      new BurikoMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\game'),
    ),
    encode = (value) => text.encodeWide(value, 1),
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
      processing,
    ),
    loading = new BurikoResourceLoadingState(resources),
    channels = new BurikoAudioChannels(
      new BurikoSpeakerContext(new BurikoMemorySpeakerBackend(1000)),
      new BurikoNativeLocks(allocator),
      allocator,
      new BurikoSystemTicks({now: () => 0}),
      {prefer24Bit: false},
    ),
    cache = new BurikoAudioArchiveCache(channels, files),
    streams = new BurikoAudioResourceStreams(channels, cache, files),
    audio = new BurikoAudioLoaderQueues(
      loading,
      new BurikoAudioMusicResources(resources, streams),
      new BurikoAudioStaticResources(channels),
    ),
    scripts = new BurikoScriptFiles(
      files,
      allocator,
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    ),
    worker = new BurikoSharedLoaderWorker(loading, audio, scripts),
    caller = {};
  try {
    worker.start({automatic: false});
    const handle = {bytes: new Uint8Array(4), offset: 0};
    assert.equal(
      await scripts.open(handle, {bytes: encode('C:\\game\\document'), offset: 0}, 0, caller),
      0,
    );
    const id = new DataView(handle.bytes.buffer).getUint32(0, true);
    await worker.closeProgramScripts(caller);
    assert.equal(scripts.find(id), null);
    assert.equal(scripts.hasLiveSection, false);
    assert.equal(worker.isRunning, true);

    const output = {bytes: null},
      result = {value: 99};
    loading.enqueueOwned(output, result, null, encode('document'), 0, 0, caller);
    for (let attempt = 0; result.value !== 3 && attempt < 100; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(result.value, 3);
    assert.deepEqual([...output.bytes], [11, 22, 33]);
    await worker.shutdown(caller);
    await worker.join();
    assert.equal(worker.isRunning, false);
  } finally {
    if (worker.isRunning) {
      await worker.shutdown(caller);
      await worker.join();
    }
    processing.dispose();
  }
});
