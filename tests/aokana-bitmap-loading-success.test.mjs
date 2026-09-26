import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoProgramResources} from '../dist/engines/buriko/native/program-resources.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoResourceLoadingState} from '../dist/engines/buriko/native/resource-loading.js';
import {BurikoBitmapLoadState} from '../dist/engines/buriko/native/bitmap-load-state.js';
import {BurikoBitmapLoading} from '../dist/engines/buriko/native/bitmap-loading.js';
import {createBurikoBitmapLoadingSlots} from '../dist/engines/buriko/native/group-bitmap-loading.js';
import {BurikoProcedureState} from '../dist/engines/buriko/native/procedure.js';
import {
  burikoPackedBitmapFormat,
  decodeBurikoPackedBitmap,
  importBurikoPackedBitmap,
  importBurikoWindowsBitmap,
} from '../dist/engines/buriko/native/bitmap-image.js';
import {
  parseBurikoBitmapLayers,
  burikoJapaneseNumber,
} from '../dist/engines/buriko/native/bitmap-layer-spec.js';
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpScheduler} from '../dist/engines/buriko/bp/scheduler.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {SourceFileSystem} from '../dist/platform/filesystem.js';
import {WindowsFileSystem, windowsFileKey} from '../dist/platform/windows-filesystem.js';
import {BlobSource} from '../dist/core/source.js';

const bytes = (value) => new TextEncoder().encode(value);
function packed(width, height, bits, payload, metadata = null, compressed = 0) {
  const out = new Uint8Array(16 + payload.length),
    view = new DataView(out.buffer);
  [width, height, bits, compressed].forEach((n, i) => view.setUint16(i * 2, n, true));
  if (metadata !== null) {
    view.setUint16(10, 1, true);
    view.setUint16(12, metadata[0], true);
    view.setUint16(14, metadata[1], true);
  }
  out.set(payload, 16);
  return out;
}
const rgba = (width, height, words, metadata = null) =>
  packed(
    width,
    height,
    32,
    Uint8Array.from(words.flatMap((p) => [p & 255, (p >>> 8) & 255, (p >>> 16) & 255, p >>> 24])),
    metadata,
  );
const words = (bitmap) =>
  Array.from({length: bitmap.width * bitmap.height}, (_, i) =>
    bitmap.storage.view.getUint32(
      bitmap.offset + Math.floor(i / bitmap.width) * bitmap.stride + (i % bitmap.width) * 4,
      true,
    ),
  );

function setup() {
  const text = new BurikoNativeText(),
    allocator = new BurikoDistributedAllocator(1);
  const compositor = new BurikoBitmapCompositor(),
    surfaces = new BurikoSurfaces(new BurikoNativeFonts(text), compositor, allocator);
  const sources = new SourceFileSystem(windowsFileKey);
  const fs = new WindowsFileSystem(sources, {
    cwd: 'C:\\game',
    mounts: [{windows: 'C:\\', virtual: '/'}],
  });
  const media = new BurikoProgramMedia();
  media.setDriveType(2, 3);
  const files = new BurikoProgramFiles(fs, text, media),
    clock = new BurikoNativeClock(() => 100);
  const input = new BurikoNativeInput(new BurikoNativeDisplayState(1920, 1080), clock);
  const fatal = () => assert.fail('Successful synthetic bitmap loading does not open a diagnostic');
  const resources = new BurikoProgramResources(
    files,
    {
      nativeFileRoot: 'C:\\game\\',
      primaryRoot: bytes('C:\\game\\'),
      secondaryRoot: bytes('C:\\disc\\'),
      secondaryMediaPath: 'C:\\disc\\',
      searchDirectoriesEnabled: 0,
      searchDirectories: [],
      retryTitle: bytes('Media'),
      retryMessage: bytes('Insert'),
      quitConfirmation: bytes('Quit?'),
    },
    {show: fatal},
    {fatal, threadFatal: fatal},
    new BurikoDistributedProcessing(allocator, 1),
  );
  const loading = new BurikoResourceLoadingState(resources),
    policy = new BurikoBitmapLoadState(input, clock);
  const service = new BurikoBitmapLoading(surfaces, loading, policy);
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 64,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const memory = new BurikoBpMemory(new Uint8Array(1024));
  const scheduler = new BurikoBpScheduler(thread, () => 1),
    procedures = new BurikoProcedureState();
  const slots = createBurikoBitmapLoadingSlots(service, scheduler, procedures, clock);
  return {
    text,
    surfaces,
    loading,
    policy,
    service,
    thread,
    memory,
    scheduler,
    slots,
    mount(name, data) {
      sources.attach('/game/' + name, new BlobSource(new Blob([data])));
    },
    async call(primary, secondary, ...args) {
      args.forEach((n) => push32(thread, n));
      return slots
        .find((s) => s.primary === primary && s.secondary === secondary)
        .execute({thread, memory});
    },
    name(value) {
      memory.globalMemory.set(bytes(value + '\0'), 32);
      return 32;
    },
  };
}

test('packed bitmap delta planes carry predictors across serpentine rows and preserve metadata', () => {
  const s = setup();
  const source = packed(
    3,
    2,
    24,
    Uint8Array.of(1, 2, 3, 4, 5, 6, 10, 0, 0, 1, 0, 0, 100, 1, 1, 1, 1, 1),
    [7, 9],
    1,
  );
  const decoded = decodeBurikoPackedBitmap(source);
  assert.equal(new DataView(decoded.buffer).getUint16(6, true), 0);
  assert.equal(burikoPackedBitmapFormat(decoded), 1);
  assert.equal(importBurikoPackedBitmap(s.surfaces, 4, source), 0);
  assert.deepEqual(
    words(s.surfaces.descriptor(4)),
    [0x640a01, 0x650a03, 0x660a06, 0x690b15, 0x680b0f, 0x670b0a],
  );
  assert.deepEqual([s.surfaces.record(4).metadataX, s.surfaces.record(4).metadataY], [7, 9]);
  assert.equal(new DataView(source.buffer).getUint16(6, true), 1);
});

test('native BMP import reads bottom-up padded BGR rows and writes DWORD RGB pixels', () => {
  const s = setup(),
    source = new Uint8Array(78),
    view = new DataView(source.buffer);
  view.setUint16(0, 0x4d42, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, 3, true);
  view.setInt32(22, 2, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  source.set([7, 8, 9, 10, 11, 12, 13, 14, 15, 99, 99, 99], 54);
  source.set([1, 2, 3, 4, 5, 6, 16, 17, 18, 88, 88, 88], 66);
  assert.equal(importBurikoWindowsBitmap(s.surfaces, 5, source), 0);
  assert.deepEqual(
    words(s.surfaces.descriptor(5)),
    [0x030201, 0x060504, 0x121110, 0x090807, 0x0c0b0a, 0x0f0e0d],
  );
  assert.equal(s.surfaces.descriptor(5).format, 1);
  assert.deepEqual([s.surfaces.record(5).metadataX, s.surfaces.record(5).metadataY], [-1, -1]);
});

test('bitmap layer parsing preserves spelling and selects explicit positions, modes and opacity', () => {
  const parsed = parseBurikoBitmapLayers(
    new BurikoNativeText(),
    bytes(' Base > 0,0,8,256 / Overlay,1,0,4,128 '),
  );
  assert.equal(parsed.result, 0);
  assert.deepEqual(
    parsed.layers.map((layer) => ({
      ...layer,
      name: new TextDecoder().decode(layer.name.subarray(0, -1)),
    })),
    [
      {needsLoad: true, name: 'Base', positioned: true, x: 0, y: 0, mode: 128, opacity: 256},
      {needsLoad: true, name: 'Overlay', positioned: true, x: 1, y: 0, mode: 36, opacity: 128},
    ],
  );
  assert.equal(burikoJapaneseNumber(1234), '千二百三十四');
});

test('90 10 joins the real BP scheduler, waits for its actual queue and releases its successful process', async () => {
  const s = setup(),
    image = rgba(2, 2, [0xff010203, 0xff040506, 0xff070809, 0xff101112]);
  s.mount('pic', image);
  for (const slot of s.slots)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[slot.primary][slot.secondary]);
  assert.equal(await s.call(0x90, 0x10, 6, 0, s.name('pic')), 2);
  assert.equal(s.thread.stackIndex, 0);
  assert.equal(s.loading.activeProcedures, 1);
  assert.equal(await s.scheduler.root.pollProcess(false), 0);
  assert.equal(s.loading.hasPending, true);
  assert.equal(s.surfaces.descriptor(6), null);
  await s.loading.processNext();
  assert.equal(await s.scheduler.root.pollProcess(false), 1);
  assert.equal(s.scheduler.root.process, null);
  assert.equal(s.loading.activeProcedures, 0);
  assert.deepEqual(
    words(s.surfaces.descriptor(6)),
    [0xff010203, 0xff040506, 0xff070809, 0xff101112],
  );
});

test('92 preload and 90 cached load share both cache owners without starting another load procedure', async () => {
  const s = setup(),
    image = rgba(2, 1, [0xff112233, 0xff445566]);
  s.loading.cache.configure(1024);
  s.mount('pic', image);
  assert.equal(await s.call(0x92, 0x14, 0, s.name('pic')), 2);
  assert.equal(await s.scheduler.root.pollProcess(false), 0);
  await s.loading.processNext();
  assert.equal(await s.scheduler.root.pollProcess(false), 1);
  assert.equal(s.loading.preloaded.size(null, bytes('pic')), image.length);
  assert.deepEqual(s.loading.cache.read(null, bytes('PIC')), image);
  assert.equal(await s.call(0x90, 0x10, 9, 0, s.name('pic')), 0);
  assert.equal(s.loading.preloaded.size(null, bytes('pic')), null);
  assert.equal(s.loading.activeProcedures, 0);
  assert.equal(s.loading.hasPending, false);
  assert.deepEqual(words(s.surfaces.descriptor(9)), [0xff112233, 0xff445566]);
  s.loading.preloaded.insert(null, bytes('remaining'), image);
  assert.equal(await s.call(0x92, 0x15), 0);
  assert.equal(s.loading.preloaded.size(null, bytes('remaining')), null);
});

test('layered load composes in list order, uses header positions and retains source cache payloads', async () => {
  const s = setup();
  const base = rgba(3, 2, new Array(6).fill(0xff102030), [9, 11]);
  const overlay = rgba(
    3,
    2,
    [0xff010203, 0xff040506, 0xff070809, 0xff101112, 0xff131415, 0xff161718],
    [1, 0],
  );
  s.loading.cache.configure(4096);
  s.mount('base', base);
  s.mount('overlay', overlay);
  assert.equal(await s.call(0x90, 0x10, 3, 0, s.name('base/overlay')), 2);
  assert.equal(await s.scheduler.root.pollProcess(false), 0);
  await s.loading.processNext();
  assert.equal(await s.scheduler.root.pollProcess(false), 0);
  assert.equal(s.loading.hasPending, false);
  assert.equal(await s.scheduler.root.pollProcess(false), 0);
  await s.loading.processNext();
  assert.equal(await s.scheduler.root.pollProcess(false), 1);
  assert.deepEqual(
    words(s.surfaces.descriptor(3)),
    [0xff102030, 0xff010203, 0xff040506, 0xff102030, 0xff101112, 0xff131415],
  );
  assert.deepEqual([s.surfaces.record(3).metadataX, s.surfaces.record(3).metadataY], [9, 11]);
  assert.deepEqual(s.loading.cache.read(null, bytes('base')), base);
  assert.deepEqual(s.loading.cache.read(null, bytes('overlay')), overlay);
  assert.equal(s.loading.cache.bytesUsed, base.length + overlay.length + base.length);
  assert.equal(s.loading.activeProcedures, 0);
});

test('90 10 uses the synchronous load branch while the configured bitmap delay is active', async () => {
  const s = setup();
  s.policy.setDelay(50);
  s.mount('sync', rgba(1, 1, [0xffabc123]));
  assert.equal(await s.call(0x90, 0x10, 7, 0, s.name('sync')), 0);
  assert.equal(s.scheduler.root.process, null);
  assert.equal(s.loading.hasPending, false);
  assert.equal(s.loading.activeProcedures, 0);
  assert.deepEqual(words(s.surfaces.descriptor(7)), [0xffabc123]);
});
