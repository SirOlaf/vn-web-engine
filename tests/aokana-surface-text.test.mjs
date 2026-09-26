import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoEngineErrors} from '../dist/engines/buriko/native/engine-errors.js';
import {BurikoBpDiagnostics} from '../dist/engines/buriko/native/diagnostics.js';
import {createGroup92SurfaceText} from '../dist/engines/buriko/native/group-92-surface-text.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {readRasterText} from '../dist/text/raster-text.js';

test('registered surface text draws multiline width and wrapped line metrics through the shared font cache', async () => {
  const text = new BurikoNativeText(),
    created = [];
  const fonts = new BurikoNativeFonts(text, {
    async queryCharset() {
      return 1;
    },
    async create(parameters) {
      created.push(parameters);
      return {
        faceName: parameters.face,
        familyName: parameters.face,
        averageWidth: 0,
        ascent: 8,
        abc() {
          return [0, 4, 0];
        },
        extent() {
          return 4;
        },
        rasterText(_value, width, height) {
          const bytes = new Uint8Array(width * height);
          // At sampleScale1, exactly four output columns are covered.
          for (let y = 0; y < height; y++) bytes.fill(255, y * width, y * width + 4);
          return {stride: width, bytes};
        },
      };
    },
    dispose() {},
  });
  fonts.rasterSettings.setQuality(-1);
  const font = fonts.registerName(text.encodeWide('SurfaceSynthetic', 0), 0);
  const compositor = new BurikoBitmapCompositor();
  compositor.defaultFormat = 1;
  const surfaces = new BurikoSurfaces(fonts, compositor, new BurikoDistributedAllocator(1));
  const initialize = (id, width, height) =>
    assert.equal(
      surfaces.importRaw(id, width, height, 1, {
        bytes: new Uint8Array(width * height * 3),
        offset: 0,
      }),
      1,
    );
  initialize(1, 24, 24);
  initialize(2, 16, 32);
  initialize(3, 16, 32);
  const errors = new BurikoEngineErrors(
    {text},
    {show: () => assert.fail('Unexpected ordinary surface text error')},
    Uint8Array.of(0),
    Uint8Array.of(0),
  );
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 32,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const memory = new BurikoBpMemory(new Uint8Array(256));
  memory.globalMemory.set(text.encodeWide('A\nBC', 1), 32);
  memory.globalMemory.set(text.encodeWide('ABCDE', 1), 96);
  const context = {
    thread,
    memory,
    diagnostics: new BurikoBpDiagnostics(() => assert.fail('Unexpected diagnostic')),
  };
  const definitions = createGroup92SurfaceText(surfaces, errors);
  const slots = new Map(definitions.map((slot) => [slot.secondary, slot]));
  for (const slot of definitions)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x92][slot.secondary]);
  const run = async (secondary, values, expected) => {
    for (const value of values) push32(thread, value);
    assert.equal(await slots.get(secondary).execute(context), 0);
    assert.equal(pop32(thread), expected);
    assert.equal(thread.stackIndex, 0);
  };
  const pixel = (surface, x, y) => {
    assert.equal(surfaces.readPixel({bytes: memory.globalMemory, offset: 8}, surface, x, y), 0);
    return new DataView(memory.globalMemory.buffer).getUint32(8, true);
  };
  await run(0x1c, [1, 1, 1, 32, font, 8, 100, 0, 0, 0xff0000], 8);
  // Maximum width is max(4,8); newline moves by exactly size8.
  assert.equal(pixel(1, 1, 1), 0xfe0000);
  assert.equal(pixel(1, 4, 8), 0xfe0000);
  assert.equal(pixel(1, 5, 1), 0);
  assert.equal(pixel(1, 8, 9), 0xfe0000);
  assert.equal(pixel(1, 9, 9), 0);

  await run(0x1d, [2, 0, 0, 96, font, 8, 100, 0, 0, 0x00ff00, 50], 3);
  // Native threshold is width16-fullAdvance8: two half-width glyphs per line.
  // linePercent50 adds four blank rows: rows0..7,12..19,24..31.
  for (const y of [0, 7, 12, 19, 24, 31]) assert.equal(pixel(2, 0, y), 0x00fe00);
  for (const y of [8, 11, 20, 23]) assert.equal(pixel(2, 0, y), 0);
  assert.equal(pixel(2, 7, 0), 0x00fe00);
  assert.equal(pixel(2, 8, 0), 0);
  assert.equal(pixel(2, 4, 24), 0);
  assert.equal(created.length, 1);
  assert.equal(created[0].face, 'SurfaceSynthetic');
  assert.equal(surfaces.drawSurface(3, 0, 0, 2, 0x80, 0), 0);
  assert.equal(pixel(3, 0, 24), 0x00fe00);
  assert.equal(pixel(3, 0, 23), 0);
  const copiedText = readRasterText(surfaces.snapshot(3));
  assert.equal(copiedText.map((glyph) => glyph.text).join(''), 'ABCDE');
  assert.deepEqual(
    copiedText.map((glyph) => glyph.y),
    [0, 0, 12, 12, 24],
  );
});
