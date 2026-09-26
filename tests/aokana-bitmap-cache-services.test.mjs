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

import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaResourceLoadingState} from '../dist/engines/buriko/games/aokana/native/resource-loading.js';
import {AokanaBitmapRegistration} from '../dist/engines/buriko/games/aokana/native/bitmap-registration.js';
import {AokanaBitmapLoading} from '../dist/engines/buriko/games/aokana/native/bitmap-loading.js';
import {AokanaBitmapLoadState} from '../dist/engines/buriko/games/aokana/native/bitmap-load-state.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaNativeInput} from '../dist/engines/buriko/games/aokana/native/input.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {bitmapRead32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';

import {AokanaBitmapCacheServices} from '../dist/engines/buriko/games/aokana/native/bitmap-cache-services.js';
import {createGroup90BitmapCacheServices} from '../dist/engines/buriko/games/aokana/native/group-90-bitmap-cache-services.js';
import {AokanaRawSurfaceExport} from '../dist/engines/buriko/games/aokana/native/raw-surface-export.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

test('90:C0/C1/C6/C7 allocate headers and consume shared resource/preload caches into real surfaces', async () => {
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
    thread = new AokanaBpThread({id: 1, operandCapacity: 8, moduleCapacity: 0, frameCapacity: 0}),
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
    slots = createGroup90BitmapCacheServices(
      new AokanaBitmapCacheServices(bitmapLoading, registration),
    ),
    pointer = (offset) => ({bytes: memory.globalMemory, offset}),
    packed = Uint8Array.from([
      2, 0, 1, 0, 32, 0, 0, 0, 0, 0, 1, 0, 7, 0, 9, 0, 51, 34, 17, 255, 102, 85, 68, 255,
    ]),
    raw = new Uint8Array(48),
    legacy = new Uint8Array(48),
    rawView = new DataView(raw.buffer),
    legacyView = new DataView(legacy.buffer);
  rawView.setUint16(0, 2, true);
  rawView.setUint16(2, 2, true);
  rawView.setUint16(4, 24, true);
  rawView.setUint16(10, 1, true);
  rawView.setUint16(12, 3, true);
  rawView.setUint16(14, 4, true);
  legacy.set(new TextEncoder().encode('CompressedBG___\0'));
  legacyView.setUint16(16, 3, true);
  legacyView.setUint16(18, 1, true);
  legacyView.setUint16(20, 32, true);
  legacyView.setUint16(26, 1, true);
  legacyView.setUint16(28, 5, true);
  legacyView.setUint16(30, 6, true);
  await fs.commit([
    {kind: 'write', path: '/raw.bg', data: raw},
    {kind: 'write', path: '/legacy.bg', data: legacy},
  ]);
  memory.globalMemory.set(encode('raw.bg'), 32);
  memory.globalMemory.set(encode('legacy.bg'), 64);
  memory.globalMemory.set(encode(' raw.bg ,0,0 / legacy.bg '), 96);
  memory.globalMemory.set(encode('cached-pixels'), 160);
  memory.globalMemory.set(encode('retained output'), 192);
  memory.globalMemory.set(packed, 256);
  loading.cache.configure(1024);
  const call = async (secondary, args, result = null) => {
    const slot = slots.find((s) => s.secondary === secondary);
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x90][secondary]);
    args.forEach((value) => push32(thread, value));
    assert.equal(await slot.execute({thread, memory, diagnostics: {}}), 0);
    if (result !== null) assert.equal(pop32(thread), result);
    assert.equal(thread.stackIndex, 0);
  };
  const pixels = (index) => {
    const bitmap = surfaces.snapshot(index);
    return Array.from({length: bitmap.width * bitmap.height}, (_, i) =>
      bitmapRead32(
        bitmap,
        bitmap.offset + Math.floor(i / bitmap.width) * bitmap.stride + (i % bitmap.width) * 4,
      ),
    );
  };
  try {
    await call(0xc0, [0, 0, 32]);
    await call(0xc0, [1, 0, 64]);
    assert.deepEqual(
      [surfaces.snapshot(0).width, surfaces.snapshot(0).height, surfaces.snapshot(0).format],
      [2, 2, 1],
    );
    assert.deepEqual(
      [surfaces.snapshot(1).width, surfaces.snapshot(1).height, surfaces.snapshot(1).format],
      [3, 1, 2],
    );
    assert.deepEqual(pixels(0), [0, 0, 0, 0]);
    assert.deepEqual(pixels(1), [0, 0, 0]);
    assert.deepEqual([surfaces.record(0).metadataX, surfaces.record(0).metadataY], [3, 4]);
    assert.deepEqual([surfaces.record(1).metadataX, surfaces.record(1).metadataY], [5, 6]);
    await call(0xc1, [192, 0, 96], 1);
    assert.equal(text.decodeAuto(pointer(192)), 'retained output');
    await call(0xc6, [0, 160, 256, packed.length], 1);
    assert.equal(loading.preloaded.size(null, encode('cached-pixels')), packed.length);
    await call(0xc7, [2, 0, 160, 1], 1);
    assert.deepEqual(pixels(2), [0xff112233, 0xff445566]);
    assert.deepEqual([surfaces.record(2).metadataX, surfaces.record(2).metadataY], [7, 9]);
    assert.equal(loading.preloaded.size(null, encode('cached-pixels')), null);
    assert.deepEqual(loading.cache.read(null, encode('cached-pixels')), packed);
    await call(0xc7, [3, 0, 160, 1], 1);
    assert.deepEqual(pixels(3), [0xff112233, 0xff445566]);
    assert.equal(new AokanaRawSurfaceExport(surfaces).export(pointer(512), pointer(480), 64, 3), 0);
    assert.deepEqual(
      Array.from(memory.globalMemory.subarray(512, 520)),
      [51, 34, 17, 255, 102, 85, 68, 255],
    );
    assert.equal(new DataView(memory.globalMemory.buffer).getUint32(480, true), 8);
  } finally {
    processing.dispose();
  }
});
