import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaMountedFileMetadata} from '../dist/engines/buriko/games/aokana/native/file-metadata.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaEngineDialogs} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {AokanaEngineErrors} from '../dist/engines/buriko/games/aokana/native/engine-errors.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaProgramResources} from '../dist/engines/buriko/games/aokana/native/program-resources.js';
import {AokanaResourceLoadingState} from '../dist/engines/buriko/games/aokana/native/resource-loading.js';
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
import {AokanaScriptFiles} from '../dist/engines/buriko/games/aokana/native/script-files.js';
import {AokanaSharedLoaderWorker} from '../dist/engines/buriko/games/aokana/native/shared-loader-worker.js';

test('per-program script close leaves one mounted loader alive until final stop', async () => {
  const backing = new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase());
  await backing.commit([{kind: 'write', path: '/game/document', data: Uint8Array.of(11, 22, 33)}]);
  const mounted = new AokanaMountedFileMetadata(backing, {
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
    allocator = new AokanaDistributedAllocator(1),
    processing = new AokanaDistributedProcessing(allocator, 1),
    text = new AokanaNativeText(),
    files = new AokanaProgramFiles(
      mounted,
      text,
      new AokanaProgramMedia(),
      new AokanaMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\game'),
    ),
    encode = (value) => text.encodeWide(value, 1),
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
      processing,
    ),
    loading = new AokanaResourceLoadingState(resources),
    channels = new AokanaAudioChannels(
      new AokanaSpeakerContext(new AokanaMemorySpeakerBackend(1000)),
      new AokanaNativeLocks(allocator),
      allocator,
      new AokanaSystemTicks({now: () => 0}),
      {prefer24Bit: false},
    ),
    cache = new AokanaAudioArchiveCache(channels, files),
    streams = new AokanaAudioResourceStreams(channels, cache, files),
    audio = new AokanaAudioLoaderQueues(
      loading,
      new AokanaAudioMusicResources(resources, streams),
      new AokanaAudioStaticResources(channels),
    ),
    scripts = new AokanaScriptFiles(
      files,
      allocator,
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    ),
    worker = new AokanaSharedLoaderWorker(loading, audio, scripts),
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
