import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpScheduler} from '../dist/engines/buriko/bp/scheduler.js';
import {BurikoBpDiagnostics} from '../dist/engines/buriko/native/diagnostics.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoProcedureState} from '../dist/engines/buriko/native/procedure.js';
import {BurikoLoadSoundProcess} from '../dist/engines/buriko/native/load-sound-process.js';
import {BurikoRegisterSoundProcess} from '../dist/engines/buriko/native/register-sound-process.js';
import {createGroupA0SoundProcesses} from '../dist/engines/buriko/native/group-a0-sound-processes.js';
import {createGroupA0StaticPlay} from '../dist/engines/buriko/native/group-a0-static-play.js';
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
import {BURIKO_BP_ABI_169, BURIKO_BP_ABI_172} from '../dist/engines/buriko/bp/abi.js';

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

for (const abi of [BURIKO_BP_ABI_169, BURIKO_BP_ABI_172])
  test(`BGI ${abi.compatibility} static sound processes render short PCM with native defaults`, async () => {
    const caller = {},
      actors = new BurikoDistributedAllocator(1),
      locks = new BurikoNativeLocks(actors);
    locks.initializeEngine();
    const backend = new BurikoMemorySpeakerBackend(1000),
      channels = new BurikoAudioChannels(
        new BurikoSpeakerContext(backend, abi),
        locks,
        actors,
        new BurikoSystemTicks({now: () => 0}),
        {prefer24Bit: false},
      );
    channels.initialize({});
    channels.activate();
    const backing = new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase());
    await backing.commit([{kind: 'write', path: '/game/voice.bw', data: pcm(8192)}]);
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
      streams = new BurikoAudioResourceStreams(channels, cache, files, abi),
      music = new BurikoAudioMusicResources(resources, streams),
      statics = new BurikoAudioStaticResources(channels),
      audio = new BurikoAudioLoaderQueues(loading, music, statics),
      scripts = new BurikoScriptFiles(
        files,
        actors,
        (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      ),
      worker = new BurikoSharedLoaderWorker(loading, audio, scripts),
      root = new BurikoBpThread({id: 0, operandCapacity: 8, moduleCapacity: 0, frameCapacity: 0}),
      thread = new BurikoBpThread({
        id: 1,
        operandCapacity: 16,
        moduleCapacity: 2,
        frameCapacity: 0,
      }),
      scheduler = new BurikoBpScheduler(root, () => 1),
      node = scheduler.append(thread),
      memory = new BurikoBpMemory(new Uint8Array(0x400), abi),
      context = {thread, actor: caller, memory, diagnostics: new BurikoBpDiagnostics(() => {})},
      slots = createGroupA0SoundProcesses(
        worker,
        scheduler,
        new BurikoProcedureState(),
        new BurikoNativeClock(() => 0),
      ),
      play = createGroupA0StaticPlay(statics, errors)[0];
    const awaitCompletion = async () => {
      for (let attempt = 0; attempt < 100 && node.process !== null; attempt++)
        await scheduler.run();
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
      assert.ok(node.process instanceof BurikoLoadSoundProcess);
      assert.equal(loading.activeProcedures, 1);
      await awaitCompletion();
      assert.equal(loading.hasPending, false);
      assert.equal(audio.hasStatic, false);
      await playSound(0, [0, 0.25, 0, -0.25]);

      // A0:20 has only three operands. In1.69 it must allocate exactly this4-frame sound,
      // preserve gain1, and stop cleanly before any uninitialized30ms descriptor suffix.
      for (const value of [0, 0, 0x100]) push32(thread, value);
      assert.equal(await slots[0].execute(context), 2);
      await awaitCompletion();
      const defaultSound = backend.buffers.at(-1);
      assert.equal(defaultSound.format.byteLength, abi.compatibility === '1.69' ? 8 : 60);
      if (abi.compatibility === '1.69') {
        for (const value of [0, 128, 64]) push32(thread, value);
        assert.equal(await play.execute(context), 0);
        assert.equal(pop32(thread), 4);
        assert.deepEqual(
          [...defaultSound.render(40)[0]],
          [0, 0.25, 0, -0.25, ...Array(36).fill(0)],
        );
        assert.equal(channels.static.length, 64);
      } else {
        assert.equal(channels.static.length, 128);
        assert.deepEqual([...defaultSound.core.bytes.subarray(0, 8)], Array(8).fill(0));
      }
      await channels.releaseStatic(0);

      if (abi.compatibility === '1.72') {
        memory.globalMemory.set(pcm(16384), 0x200);
        for (const value of [1, 0x200, 0, 65536, 65536]) push32(thread, value);
        assert.equal(slots[4].execute(context), 2);
        assert.ok(node.process instanceof BurikoRegisterSoundProcess);
        assert.equal(loading.activeProcedures, 1);
        await awaitCompletion();
        assert.equal(audio.hasStatic, false);
        await playSound(1, [0, 0.5, 0, -0.5]);
      } else {
        const longSound = new Uint8Array(64 + 200 * 2),
          view = new DataView(longSound.buffer);
        longSound.set(pcm(8192).subarray(0, 64));
        view.setUint32(8, 400, true);
        view.setUint32(12, 200, true);
        for (let frame = 0; frame < 200; frame++) view.setInt16(64 + frame * 2, frame, true);
        await backing.commit([{kind: 'write', path: '/game/voice.bw', data: longSound}]);
        for (const value of [1, 0, 0x100, 0, 65536]) push32(thread, value);
        assert.equal(await slots[2].execute(context), 2);
        await awaitCompletion();
        const fast = backend.buffers.at(-1);
        assert.equal(fast.format.byteLength, 300); //150allocated frames,125copied.
        for (const value of [1, 128, 64]) push32(thread, value);
        assert.equal(await play.execute(context), 0);
        assert.equal(pop32(thread), 100);
        assert.deepEqual(
          [...fast.render(125)[0]],
          [
            ...Array.from({length: 75}, (_, i) => i / 32768),
            ...Array.from({length: 50}, (_, i) => (150 + i) / 32768),
          ],
        );
        assert.equal(fast.core.initialized.subarray(250).some(Boolean), false);
        await channels.releaseStatic(1);
      }
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
