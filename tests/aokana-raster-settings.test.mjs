import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {allocateBurikoBitmap, BurikoBitmapStorage} from '../dist/engines/buriko/native/bitmap.js';
import {bitmapRead32, bitmapWrite32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {displaceBurikoBitmap} from '../dist/engines/buriko/native/bitmap-displacement.js';
import {BurikoBitmapText} from '../dist/engines/buriko/native/font-bitmap.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoVmControlState} from '../dist/engines/buriko/native/group-80-threads.js';
import {createGroup91RasterSettings} from '../dist/engines/buriko/native/group-91-raster-settings.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

test('raster opcodes affect actual additive, displacement and cached font consumers', async () => {
  const text = new BurikoNativeText(),
    created = [],
    sampled = [],
    pitchQueries = [];
  const fonts = new BurikoNativeFonts(text, {
    async queryCharset() {
      return 1;
    },
    async queryPitch(name) {
      pitchQueries.push(name);
      return 2;
    },
    async create(parameters) {
      created.push(parameters);
      return {
        faceName: parameters.face,
        familyName: parameters.face,
        averageWidth: 0,
        ascent: parameters.height,
        abc() {
          return [0, 16, 0];
        },
        extent() {
          return 16;
        },
        rasterText(value, width, height) {
          sampled.push(value);
          const bytes = new Uint8Array(width * height);
          // Each complete 4x4 sample has exactly eight covered samples.
          for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++) bytes[y * width + x] = x % 4 < 2 ? 255 : 0;
          return {stride: width, bytes};
        },
      };
    },
    dispose() {},
  });
  const compositor = new BurikoBitmapCompositor();
  compositor.defaultFormat = 2;
  const definitions = createGroup91RasterSettings(compositor, fonts, new BurikoVmControlState());
  const slots = new Map(definitions.map((slot) => [slot.secondary, slot]));
  for (const slot of definitions)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x91][slot.secondary]);
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: new BurikoBpMemory(new Uint8Array()), diagnostics: {}};
  const run = (secondary, values, hasResult = true) => {
    for (const value of values) push32(thread, value);
    assert.equal(slots.get(secondary).execute(context), 0);
    if (hasResult) assert.equal(pop32(thread), 1);
    assert.equal(thread.stackIndex, 0);
  };
  const source = allocateBurikoBitmap(1, 1, 2),
    target = allocateBurikoBitmap(1, 1, 2);
  bitmapWrite32(source, source.offset, 0x80402010);
  for (const [property, expected] of [
    [0, 0x80201008],
    [1, 0x80402010],
  ]) {
    run(0x0a, [0x01220000, property]);
    bitmapWrite32(target, target.offset, 0);
    assert.equal(compositor.composite(target, source, 2, 256), 0);
    assert.equal(bitmapRead32(target, target.offset), expected);
  }

  // An ordinary horizontal displacement can wrap to the next initialized row
  // under linear clipping; rectangular clipping clips that border sample.
  const full = allocateBurikoBitmap(4, 2, 2);
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 4; x++)
      bitmapWrite32(full, full.offset + y * full.stride + x * 4, 1 + y * 4 + x);
  const cropped = {...full, offset: full.offset + 4, width: 3, height: 1};
  const displaced = allocateBurikoBitmap(3, 1, 2);
  const mapBytes = new Uint8Array(18);
  new DataView(mapBytes.buffer).setInt16(12, 4, true);
  const map = {
    storage: new BurikoBitmapStorage(mapBytes, true),
    offset: 0,
    stride: 18,
    width: 3,
    height: 1,
    format: 6,
    bytesPerPixel: 6,
  };
  for (const [property, expected] of [
    [1, [2, 3, 0]],
    [0, [2, 3, 5]],
  ]) {
    run(0x0a, [0x80111600, property]);
    assert.equal(
      displaceBurikoBitmap(
        compositor,
        displaced,
        cropped,
        full,
        map,
        Uint32Array.of(0x40004000),
        0,
      ),
      0,
    );
    assert.deepEqual(
      [0, 1, 2].map((x) => bitmapRead32(displaced, displaced.offset + x * 4)),
      expected,
    );
  }

  const first = await fonts.get(text.encodeWide('RasterOne', 0), 8, 100, 0);
  assert.equal(first.result, 0);
  const bitmapText = new BurikoBitmapText(fonts, compositor);
  const glyphTarget = allocateBurikoBitmap(4, 8, 2);
  const draw = (value, alpha) => {
    const output = {value: 0};
    assert.equal(
      bitmapText.draw(
        glyphTarget,
        output,
        0,
        0,
        {bytes: text.encodeWide(value, 1), offset: 0},
        first.id,
        0x402010,
        0x80,
        0,
        0,
        0,
      ),
      1,
    );
    assert.equal(output.value, 4);
    assert.equal(bitmapRead32(glyphTarget, glyphTarget.offset), ((alpha << 24) | 0x402010) >>> 0);
  };
  run(0x0c, [0]);
  draw('A', 127); // floor(8*255/16).
  run(0x0c, [1]);
  draw('B', 180); // floor(sin(pi/4)*255).
  draw('A', 127); // The previously rasterized glyph remains cached.
  assert.deepEqual(sampled, ['A', 'B']);

  run(0x0d, [1], false);
  const second = await fonts.get(text.encodeWide('RasterTwo', 0), 8, 100, 0);
  assert.equal(second.result, 0);
  assert.deepEqual(pitchQueries, ['RasterTwo']);
  assert.deepEqual(
    created.map(({width, height}) => ({width, height})),
    [
      {width: 16, height: 32},
      {width: 0, height: 32},
    ],
  );
  assert.equal((await fonts.get(text.encodeWide('RasterOne', 0), 8, 100, 0)).id, first.id);
  assert.equal(created.length, 2);
});
