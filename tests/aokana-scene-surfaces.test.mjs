import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpThread, push32, pop32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoBitmapLoadState} from '../dist/engines/buriko/native/bitmap-load-state.js';
import {createGroup90Surfaces} from '../dist/engines/buriko/native/group-90-surfaces.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

function setup() {
  const fonts = new BurikoNativeFonts(new BurikoNativeText());
  const compositor = new BurikoBitmapCompositor();
  const surfaces = new BurikoSurfaces(fonts, compositor, new BurikoDistributedAllocator(1));
  const time = {now: 0},
    clock = new BurikoNativeClock(() => time.now);
  const input = new BurikoNativeInput(new BurikoNativeDisplayState(1920, 1080), clock);
  input.skipAllowed = 1;
  const loading = new BurikoBitmapLoadState(input, clock);
  const words = (index) => {
    const bitmap = surfaces.descriptor(index);
    return Array.from({length: bitmap.width * bitmap.height}, (_, i) =>
      bitmap.storage.view.getUint32(i * 4, true),
    );
  };
  const rgb = (index, width, height, pixels) => {
    const bytes = Uint8Array.from(
      pixels.flatMap((p) => [p & 255, (p >>> 8) & 255, (p >>> 16) & 255]),
    );
    assert.equal(surfaces.importRaw(index, width, height, 1, {bytes, offset: 0}), 1);
  };
  return {fonts, compositor, surfaces, time, input, loading, words, rgb};
}

test('raw surface import expands packed BGR24, honors optional row alignment and retains metadata', () => {
  const {surfaces, words} = setup();
  const bytes = Uint8Array.of(99, 1, 2, 3, 4, 5, 6, 77, 78, 7, 8, 9, 10, 11, 12, 79, 80);
  assert.equal(surfaces.importRaw(2, 2, 2, 1, {bytes, offset: 1}, [-7, 9], 1), 1);
  assert.deepEqual(words(2), [0x030201, 0x060504, 0x090807, 0x0c0b0a]);
  assert.equal(surfaces.descriptor(2).stride, 8);
  assert.equal(surfaces.descriptor(2).bytesPerPixel, 4);
  assert.deepEqual([surfaces.record(2).metadataX, surfaces.record(2).metadataY], [-7, 9]);
  assert.deepEqual(Array.from(bytes), [99, 1, 2, 3, 4, 5, 6, 77, 78, 7, 8, 9, 10, 11, 12, 79, 80]);
});

test('RGBA import removes the selected shared matte with two truncations and preserves endpoint alpha pixels', () => {
  const {surfaces, compositor, words} = setup();
  compositor.importMatteColor = 0x204060;
  const pixels = [0x80323c50, 0x00010203, 0xff112233, 0x80000000, 0x01646464];
  const bytes = new Uint8Array(new Uint32Array(pixels).buffer);
  assert.equal(surfaces.importRaw(1, 5, 1, 2, {bytes, offset: 0}), 1);
  assert.deepEqual(words(1), [0x80453941, 0x00010203, 0xff112233, 0x80000000, 0x01ffffff]);
  assert.deepEqual(Array.from(new Uint32Array(bytes.buffer)), pixels);
});

test('in-place RGB/RGBA conversion preserves the image and uses the four/two/one opaque tails', () => {
  const {surfaces, words} = setup();
  const pixels = Array.from({length: 14}, (_, i) => (((i * 17) << 24) | (i * 0x030201)) >>> 0);
  surfaces.importRaw(7, 7, 2, 2, {
    bytes: new Uint8Array(new Uint32Array(pixels).buffer),
    offset: 0,
  });
  const descriptor = surfaces.descriptor(7),
    id = surfaces.imageId(7),
    owner = descriptor.storage;
  assert.equal(surfaces.convertFormat(7, 1), 0);
  assert.deepEqual(words(7), pixels);
  assert.equal(surfaces.convertFormat(7, 2), 0);
  assert.deepEqual(
    words(7),
    pixels.map((p) => (p | 0xff000000) >>> 0),
  );
  assert.equal(surfaces.descriptor(7), descriptor);
  assert.equal(surfaces.descriptor(7).storage, owner);
  assert.equal(surfaces.imageId(7), id);
});

test('clipped region copy keeps its destination origin and flagged extraction clears the uncovered area', () => {
  const {surfaces, rgb, words} = setup();
  rgb(1, 3, 2, [1, 2, 3, 4, 5, 6]);
  surfaces.allocateChecked(2, 4, 2, 1);
  surfaces.fill(2, 0);
  assert.equal(surfaces.copyRegion(2, 1, 0, 1, -1, 0, 3, 2), 0);
  assert.deepEqual(words(2), [0, 1, 2, 0, 0, 4, 5, 0]);
  assert.equal(surfaces.extractRegion(0x80000003, 1, -1, -1, 4, 3), 0);
  assert.deepEqual(words(3), [0, 0, 0, 0, 0, 1, 2, 3, 0, 4, 5, 6]);
  assert.deepEqual(words(1), [1, 2, 3, 4, 5, 6]);
  assert.equal(surfaces.extractRegion(4, 1, 0, 0, 3, 3), 0);
  assert.deepEqual(words(4), [1, 2, 3, 4, 5, 6, 0, 0, 0]);
  assert.deepEqual(
    surfaces.snapshot(4).storage.initializedRange(0, 3 * 3 * 4),
    Uint8Array.from({length: 3 * 3 * 4}, (_, byte) => Number(byte < 3 * 2 * 4)),
  );
  assert.equal(surfaces.reduceSurfaceHalf(5, 4), 0);
});

test('surface drawing uses the complete existing compositor with source clipping and exact integer RGB blend', () => {
  const {surfaces, rgb, words} = setup();
  rgb(1, 2, 1, [0x804020, 0x020406]);
  rgb(2, 3, 1, [0xabcdef, 0x204080, 0x806040]);
  assert.equal(surfaces.drawSurface(2, 1, 0, 1, 1, 128), 0);
  assert.deepEqual(words(2), [0xabcdef, 0x504050, 0x413223]);
  assert.equal(surfaces.drawSurface(2, -1, 0, 1, 0x80, 0), 0);
  assert.deepEqual(words(2), [0x020406, 0x504050, 0x413223]);
});

test('twelve native90 wrappers share the actual surface table, native descriptor shape and bitmap-load delay', async () => {
  const s = setup(),
    thread = new BurikoBpThread({
      id: 7,
      operandCapacity: 32,
      moduleCapacity: 64,
      frameCapacity: 64,
    });
  const memory = new BurikoBpMemory(new Uint8Array(128));
  const slots = createGroup90Surfaces(s.surfaces, s.loading, {
    threadFatal() {
      assert.fail('normal surface operations should succeed');
    },
  });
  assert.equal(slots.length, 12);
  for (const slot of slots)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x90][slot.secondary]);
  const run = async (secondary, values = []) => {
    for (const value of values) push32(thread, value);
    assert.equal(
      await slots.find((slot) => slot.secondary === secondary).execute({thread, memory}),
      0,
    );
  };
  await run(0x07, [100]);
  assert.equal(s.loading.skipLoadWait(), 1);
  assert.equal(s.loading.deadline, 100);
  s.time.now = 100;
  assert.equal(s.loading.skipLoadWait(), 0);
  assert.equal(s.loading.skipLoadWait(), 1);
  assert.equal(s.loading.deadline, 200);
  s.input.skipForced = 1;
  s.time.now = 200;
  assert.equal(s.loading.skipLoadWait(), 1);
  s.input.skipForced = 0;
  assert.equal(s.loading.skipLoadWait(), 0);
  await run(0x0d, [2]);
  assert.equal(s.fonts.rasterSettings.sampleScale, 8);
  await run(0x11, [5, 2, 1, 1]);
  await run(0x13, [5, 0x112233]);
  const id = s.surfaces.imageId(5);
  await run(0x0b, [7]);
  await run(0x11, [5, 2, 1, 1]);
  assert.equal(s.surfaces.imageId(5), id);
  memory.globalMemory.set([1, 2, 3, 4, 5, 6], 8);
  await run(0x14, [5, 2, 1, 1, 8]);
  assert.deepEqual(s.words(5), [0x030201, 0x060504]);
  await run(0x16, [32, 5]);
  assert.equal(pop32(thread), 1);
  assert.deepEqual(
    Array.from(new Uint32Array(memory.globalMemory.buffer, 32, 6)),
    [0, 8, 2, 1, 1, 4],
  );
  await run(0x17, [5, 2]);
  assert.equal(pop32(thread), 0);
  assert.deepEqual(s.words(5), [0xff030201, 0xff060504]);
  await run(0x1f, [0x80000006, 5, 1, 0, 1, 1]);
  assert.deepEqual(s.words(6), [0xff060504]);
  await run(0x1e, [5, 0, 0, 6, 0, 0, 1, 1]);
  assert.deepEqual(s.words(5), [0xff060504, 0xff060504]);
  await run(0x18, [5, 1, 0, 6, 0x80, 0]);
  await run(0x12, [6]);
  assert.equal(pop32(thread), 1);
  assert.equal(thread.stackIndex, 0);
});
