import test from 'node:test';
import assert from 'node:assert/strict';
import {WasmResidentHeap} from '../dist/graphics/wasm-resident-heap.js';
import {BurikoBitmapStorage, allocateBurikoBitmap} from '../dist/engines/buriko/native/bitmap.js';
import {
  burikoResidentBuffer,
  getBurikoResidentKernel,
  setBurikoBitmapResidencyEnabled,
  setBurikoResidentBitmapBudget,
} from '../dist/engines/buriko/native/bitmap-resident.js';
import {
  tryBurikoBitmapAffineAlphaWasm,
  tryBurikoBitmapAffineWasm,
  tryBurikoBitmapAlphaWasm,
  tryBurikoBitmapFusedWasm,
  tryBurikoBitmapMixWasm,
  tryBurikoBitmapReduceWasm,
  tryBurikoBitmapTransitionWasm,
} from '../dist/engines/buriko/native/bitmap-alpha-wasm.js';
import {
  getRuntimePerformanceSnapshot,
  startRuntimePerformanceRecording,
  stopRuntimePerformanceRecording,
} from '../dist/platform/runtime-performance.js';

// These tests exercise residency itself, also when a suite run disables it globally.
setBurikoBitmapResidencyEnabled(true);

const resizable = typeof WebAssembly !== 'undefined';

function heapExports(pages = 1, maximum = 8, base = 100) {
  return {
    memory: new WebAssembly.Memory({initial: pages, maximum}),
    __heap_base: new WebAssembly.Global({value: 'i32', mutable: false}, base),
  };
}

// Runs first: the budget applies only before the resident instance reserves it.
test(
  'a budget override applies before the first reservation and not after',
  {
    skip: typeof WebAssembly === 'undefined',
  },
  () => {
    assert.equal(setBurikoResidentBitmapBudget(96 * 1024 * 1024), true);
    const storage = BurikoBitmapStorage.allocate(64 * 1024, false);
    const capacity = getBurikoResidentKernel()?.heap.capacityBytes ?? 0;
    assert.ok(capacity >= 96 * 1024 * 1024 && capacity < 100 * 1024 * 1024);
    assert.equal(setBurikoResidentBitmapBudget(null), false);
    storage.release();
  },
);

test(
  'resident heap reserves once, allocates zeroed aligned blocks and reuses freed ones',
  {
    skip: typeof WebAssembly === 'undefined',
  },
  () => {
    const exports = heapExports();
    const heap = WasmResidentHeap.create(exports, 4 * 65536);
    assert.ok(heap);
    // The whole budget is reserved up front, so the buffer never detaches afterwards.
    assert.equal(heap.buffer, exports.memory.buffer);
    assert.ok(heap.capacityBytes >= 128 + 4 * 65536);
    const first = heap.allocate(100);
    assert.equal(first.byteOffset % 64, 0);
    assert.ok(first.byteOffset >= 100);
    first.fill(7);
    const large = heap.allocate(3 * 65536);
    assert.ok(large);
    assert.equal(exports.memory.buffer, heap.buffer);
    assert.equal(first[99], 7);
    // Freed blocks come back zeroed.
    heap.release(first);
    const again = heap.allocate(64);
    assert.equal(again.byteOffset, first.byteOffset);
    assert.ok(again.every((value) => value === 0));
    // Adjacent frees coalesce, and a trailing free block rejoins the bump region.
    heap.release(again);
    heap.release(large);
    assert.equal(heap.liveBytes, 0);
    assert.equal(heap.allocate(4 * 65536 - 128)?.byteOffset, first.byteOffset);
    // Beyond the reservation allocation fails without throwing or growing.
    assert.equal(heap.allocate(heap.capacityBytes), null);
    assert.equal(exports.memory.buffer, heap.buffer);
  },
);

test(
  'resident heap reservation falls back to smaller budgets, then to none',
  {
    skip: typeof WebAssembly === 'undefined',
  },
  () => {
    const heap = WasmResidentHeap.create(heapExports(1, 3, 0), 8 * 65536, 65536);
    assert.ok(heap);
    // Eight and four pages exceed the three-page maximum; two pages fit.
    assert.equal(heap.capacityBytes, 2 * 65536);
    assert.equal(WasmResidentHeap.create(heapExports(1, 1, 0), 8 * 65536, 4 * 65536), null);
  },
);

test('storage release returns resident bytes for reuse', {skip: !resizable}, () => {
  const first = BurikoBitmapStorage.allocate(64 * 1024, false);
  assert.equal(first.bytes.buffer, burikoResidentBuffer());
  const address = first.bytes.byteOffset;
  first.bytes.fill(9);
  first.release();
  const second = BurikoBitmapStorage.allocate(64 * 1024, false);
  assert.equal(second.bytes.byteOffset, address);
  assert.ok(second.bytes.every((value) => value === 0));
  second.release();
  // Small storage and disabled residency keep ordinary buffers.
  assert.notEqual(BurikoBitmapStorage.allocate(1024, false).bytes.buffer, burikoResidentBuffer());
  setBurikoBitmapResidencyEnabled(false);
  try {
    assert.notEqual(allocateBurikoBitmap(256, 256, 2).storage.bytes.buffer, burikoResidentBuffer());
  } finally {
    setBurikoBitmapResidencyEnabled(true);
  }
});

let seed = 0x1234567;
const random = () => {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed;
};

/** A crop of a larger padded surface, resident or in an ordinary buffer, with random pixels. */
function surface(resident, width, height, format, {left = 3, top = 2, padding = 20} = {}) {
  const stride = (width + left) * 4 + padding,
    length = stride * (height + top + 1);
  const storage = resident
    ? BurikoBitmapStorage.allocate(length, true)
    : new BurikoBitmapStorage(new Uint8Array(length), true);
  assert.equal(storage.bytes.buffer === burikoResidentBuffer(), resident);
  const bytes = storage.bytes;
  for (let index = 0; index < bytes.length; index++) bytes[index] = random() >>> 24;
  return {
    storage,
    offset: top * stride + left * 4,
    stride,
    width,
    height,
    format,
    bytesPerPixel: 4,
  };
}

function packed(resident, width, height, format) {
  return surface(resident, width, height, format, {left: 0, top: 0, padding: 0});
}

function mask(resident, width, height) {
  const storage = resident
    ? BurikoBitmapStorage.allocate(width * height, true)
    : new BurikoBitmapStorage(new Uint8Array(width * height), true);
  for (let index = 0; index < storage.bytes.length; index++) storage.bytes[index] = random() >>> 24;
  return {storage, offset: 0, stride: width, width, height, format: 3, bytesPerPixel: 1};
}

/** Runs one kernel entry point on resident and ordinary copies of the same inputs. */
function compare(name, build, run) {
  const results = [];
  for (const resident of [true, false]) {
    seed = 0x9e3779b9;
    const bitmaps = build(resident);
    startRuntimePerformanceRecording();
    const applied = run(bitmaps);
    stopRuntimePerformanceRecording();
    const inPlace =
      getRuntimePerformanceSnapshot().aggregates.find(
        (aggregate) => aggregate.name === 'buriko.bitmap.wasm-resident',
      )?.total ?? 0;
    assert.equal(applied, true, `${name} ${resident ? 'resident' : 'staged'} applied`);
    assert.equal(inPlace, resident ? 1 : 0, `${name} ran in place only when resident`);
    results.push(bitmaps.destination.storage.bytes.slice());
    for (const bitmap of Object.values(bitmaps)) bitmap.storage.release();
  }
  assert.deepEqual(results[0], results[1], `${name} resident output matches staged output`);
}

const coordinates = {
  startX: 5 * 65536 + 0x3456,
  startY: 3 * 65536 + 0x1234,
  columnX: 60000,
  columnY: 9000,
  rowX: -8000,
  rowY: 61000,
};

test(
  'resident kernels match staged kernels on padded crops and packed planes',
  {
    skip: !resizable,
  },
  () => {
    for (const bilinear of [false, true]) {
      compare(
        `affine alpha ${bilinear}`,
        (resident) => ({
          destination: surface(resident, 70, 60, 1),
          source: surface(resident, 90, 80, 2, {left: 5, top: 1, padding: 12}),
        }),
        ({destination, source}) =>
          tryBurikoBitmapAffineAlphaWasm(
            destination,
            source,
            destination.storage.view,
            source.storage.view,
            coordinates,
            bilinear,
            40,
          ),
      );
      for (const [transparency, forceAlpha] of [
        [0, false],
        [70, false],
        [0, true],
      ])
        compare(
          `affine copy ${bilinear} ${transparency} ${forceAlpha}`,
          (resident) => ({
            destination: surface(resident, 70, 60, 2),
            source: surface(resident, 90, 80, 2, {left: 1, top: 4, padding: 8}),
          }),
          ({destination, source}) =>
            tryBurikoBitmapAffineWasm(
              destination,
              source,
              destination.storage.view,
              source.storage.view,
              coordinates,
              bilinear,
              transparency,
              forceAlpha,
            ),
        );
    }
    for (const transparency of [null, 90])
      compare(
        `alpha ${transparency}`,
        (resident) => ({
          destination: surface(resident, 150, 40, 1),
          source: surface(resident, 150, 40, 2, {left: 7, top: 3, padding: 36}),
        }),
        ({destination, source}) =>
          tryBurikoBitmapAlphaWasm(
            destination,
            source,
            destination.storage.view,
            source.storage.view,
            150,
            40,
            transparency,
          ),
      );
    compare(
      'alpha all channels',
      (resident) => ({
        destination: packed(resident, 128, 64, 2),
        source: packed(resident, 128, 64, 2),
      }),
      ({destination, source}) =>
        tryBurikoBitmapAlphaWasm(
          destination,
          source,
          destination.storage.view,
          source.storage.view,
          128,
          64,
          100,
          true,
        ),
    );
    compare(
      'fused',
      (resident) => ({
        destination: packed(resident, 128, 64, 1),
        first: packed(resident, 128, 64, 2),
        second: packed(resident, 128, 64, 2),
      }),
      ({destination, first, second}) =>
        tryBurikoBitmapFusedWasm(
          destination,
          first,
          second,
          destination.storage.view,
          first.storage.view,
          second.storage.view,
          128,
          64,
          150,
          30,
        ),
    );
    compare(
      'mix',
      (resident) => ({
        destination: packed(resident, 128, 64, 2),
        first: packed(resident, 128, 64, 2),
        second: packed(resident, 128, 64, 2),
      }),
      ({destination, first, second}) =>
        tryBurikoBitmapMixWasm(
          destination,
          first,
          second,
          destination.storage.view,
          first.storage.view,
          second.storage.view,
          128,
          64,
          99,
        ),
    );
    const actions = Int32Array.from({length: 256}, (_, index) =>
      index < 40 ? 0x20000 : index > 220 ? 0x10000 : (index - 128) * 97,
    );
    compare(
      'transition',
      (resident) => ({
        destination: packed(resident, 256, 80, 1),
        source: packed(resident, 256, 80, 1),
        mask: mask(resident, 256, 80),
      }),
      ({destination, source, mask}) =>
        tryBurikoBitmapTransitionWasm(
          destination,
          source,
          mask,
          destination.storage.view,
          source.storage.view,
          mask.storage.view,
          256,
          80,
          actions,
        ),
    );
    compare(
      'reduce',
      (resident) => ({
        destination: packed(resident, 97, 65, 2),
        source: packed(resident, 193, 129, 2),
      }),
      ({destination, source}) =>
        tryBurikoBitmapReduceWasm(
          destination,
          source,
          destination.storage.view,
          source.storage.view,
          96,
          64,
          true,
          true,
        ),
    );
  },
);

test(
  'overlapping resident spans are rejected like aliased ordinary buffers',
  {
    skip: !resizable,
  },
  () => {
    const shared = surface(true, 128, 64, 2);
    const crop = {...shared, offset: shared.offset + 4};
    assert.equal(
      tryBurikoBitmapAlphaWasm(
        crop,
        shared,
        shared.storage.view,
        shared.storage.view,
        128,
        64,
        null,
      ),
      false,
    );
    shared.storage.release();
  },
);
