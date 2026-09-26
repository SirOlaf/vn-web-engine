import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {AokanaProgramResources} from '../dist/engines/buriko/games/aokana/native/program-resources.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaEngineDialogs} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {AokanaEngineErrors} from '../dist/engines/buriko/games/aokana/native/engine-errors.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';

import {AokanaBpScheduler} from '../dist/engines/buriko/games/aokana/bp/scheduler.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaProcedureState} from '../dist/engines/buriko/games/aokana/native/procedure.js';
import {AokanaResourceLoadingState} from '../dist/engines/buriko/games/aokana/native/resource-loading.js';
import {AokanaDataCodecWorkers} from '../dist/engines/buriko/games/aokana/native/data-codec-workers.js';
import {createGroup91BitmapRegistration} from '../dist/engines/buriko/games/aokana/native/group-91-bitmap-registration.js';
import {AokanaBitmapRegistration} from '../dist/engines/buriko/games/aokana/native/bitmap-registration.js';
import {AokanaBitmapLoading} from '../dist/engines/buriko/games/aokana/native/bitmap-loading.js';
import {AokanaBitmapLoadState} from '../dist/engines/buriko/games/aokana/native/bitmap-load-state.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaNativeInput} from '../dist/engines/buriko/games/aokana/native/input.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {bitmapRead32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';

test('91:03/04 register actual image data through shared cache, private decoder and surface consumers', async () => {
  const fs = new StoredFileSystem(new MemoryStore()),
    text = new AokanaNativeText(),
    encode = (s) => text.encodeWide(s, 1),
    files = new AokanaProgramFiles(
      fs,
      text,
      new AokanaProgramMedia(),
      new AokanaMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\'),
    ),
    dialogs = new AokanaEngineDialogs(),
    errors = new AokanaEngineErrors(files, dialogs, encode('C:\\'), encode('C:\\')),
    processing = new AokanaDistributedProcessing(new AokanaDistributedAllocator(1), 1),
    resources = new AokanaProgramResources(
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
    loading = new AokanaResourceLoadingState(resources),
    memory = new AokanaBpMemory(new Uint8Array(0x1000)),
    root = new AokanaBpThread({id: 0, operandCapacity: 8, moduleCapacity: 0, frameCapacity: 0}),
    thread = new AokanaBpThread({id: 1, operandCapacity: 8, moduleCapacity: 256, frameCapacity: 0}),
    scheduler = new AokanaBpScheduler(root, () => 1),
    node = scheduler.append(thread),
    workers = new AokanaDataCodecWorkers(() => new Date(Date.UTC(2026, 8, 19, 12, 34, 56, 0))),
    clock = new AokanaNativeClock(() => 0),
    surfaces = new AokanaSurfaces(
      new AokanaNativeFonts(text),
      new AokanaBitmapCompositor(),
      processing.allocator,
    ),
    registration = new AokanaBitmapRegistration(loading, surfaces),
    bitmapLoading = new AokanaBitmapLoading(
      surfaces,
      loading,
      new AokanaBitmapLoadState(
        new AokanaNativeInput(new AokanaNativeDisplayState(16, 8), clock),
        clock,
      ),
    ),
    [register, decode] = createGroup91BitmapRegistration(
      registration,
      workers,
      scheduler,
      new AokanaProcedureState(),
      clock,
    ),
    packed = Uint8Array.from([
      2, 0, 1, 0, 32, 0, 0, 0, 0, 0, 1, 0, 7, 0, 9, 0, 51, 34, 17, 255, 102, 85, 68, 255,
    ]),
    cacheName = encode('cached-image'),
    preloadName = encode('preloaded-image');
  loading.cache.configure(1024);
  memory.globalMemory.set(cacheName, 32);
  memory.globalMemory.set(preloadName, 64);
  memory.globalMemory.set(packed, 256);
  const pixels = (index) => {
    const bitmap = surfaces.snapshot(index);
    return [bitmapRead32(bitmap, bitmap.offset), bitmapRead32(bitmap, bitmap.offset + 4)];
  };
  try {
    for (const value of [0, 32, 256, packed.length]) push32(thread, value);
    assert.equal(register.execute({thread, memory}), 0);
    assert.equal(pop32(thread), 0);
    assert.equal(bitmapLoading.fromCache(1, null, cacheName), 0);
    assert.deepEqual(pixels(1), [0xff112233, 0xff445566]);
    assert.deepEqual(loading.cache.read(null, cacheName), packed);

    // Independent literal-only SDC: token23 then the twenty-four packed image bytes.
    const encoded = new Uint8Array(57),
      header = new DataView(encoded.buffer);
    encoded.set(new TextEncoder().encode('SDC FORMAT 1.00\0'));
    header.setUint32(20, 25, true);
    header.setUint32(24, 24, true);
    header.setUint16(28, 3205, true);
    header.setUint16(30, 151, true);
    encoded.set(
      [
        23, 92, 130, 231, 66, 168, 205, 187, 15, 164, 150, 45, 222, 250, 95, 69, 80, 87, 131, 208,
        214, 85, 38, 90, 160,
      ],
      32,
    );
    memory.globalMemory.set(encoded, 512);
    for (const value of [2, 512, encoded.length, 0, 64, 1]) push32(thread, value);
    assert.equal(decode.execute({thread, memory}), 2);
    assert.equal(loading.activeProcedures, 1);
    assert.equal(node.pollProcess(false), 0);
    assert.equal(thread.stackIndex, 0);
    assert.equal(await scheduler.run(), 0);
    assert.equal(workers.hasPendingWork(), false);
    assert.equal(thread.stackIndex, 0);
    assert.equal(await scheduler.run(), 0);
    assert.equal(node.process, null);
    assert.equal(loading.activeProcedures, 0);
    assert.equal(pop32(thread), 0);
    assert.deepEqual(pixels(2), [0xff112233, 0xff445566]);
    assert.equal(loading.preloaded.size(null, preloadName), packed.length);
    assert.equal(bitmapLoading.fromCache(3, null, preloadName, 1), 0);
    assert.equal(loading.preloaded.size(null, preloadName), null);
    assert.deepEqual(pixels(3), pixels(2));
    assert.deepEqual(loading.cache.read(null, preloadName), packed);
    assert.equal(surfaces.record(3).metadataX, 7);
    assert.equal(surfaces.record(3).metadataY, 9);
    assert.deepEqual(memory.globalMemory.subarray(512, 569), encoded);
    assert.equal(thread.stackIndex, 0);
  } finally {
    processing.dispose();
  }
});
