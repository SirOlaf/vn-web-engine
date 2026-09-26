import test from 'node:test';
import assert from 'node:assert/strict';
import {readRasterText} from '../dist/text/raster-text.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';
import {allocateBurikoBitmap, BurikoBitmapStorage} from '../dist/engines/buriko/native/bitmap.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {clearBurikoBitmap} from '../dist/engines/buriko/native/bitmap-copy.js';
import {blendBurikoMaskColor} from '../dist/engines/buriko/native/bitmap-mask-color.js';
import {
  decodeBurikoEmbeddedText,
  isBurikoCustomGlyphCode,
  readBurikoEmbeddedCharacter,
} from '../dist/engines/buriko/native/custom-text-glyphs.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {createCustomTextGlyphSettings} from '../dist/engines/buriko/native/group-text-layout-settings.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoTextLayoutState} from '../dist/engines/buriko/native/text-layout-state.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

function setup() {
  const text = new BurikoNativeText();
  const fonts = new BurikoNativeFonts(text);
  const compositor = new BurikoBitmapCompositor();
  const surfaces = new BurikoSurfaces(fonts, compositor, new BurikoDistributedAllocator(1));
  const state = new BurikoTextLayoutState(surfaces);
  return {text, fonts, compositor, surfaces, state};
}

function bitmap(width, height, values, format, padding = 4) {
  const bytesPerPixel = format === 3 ? 1 : 4;
  const stride = width * bytesPerPixel + padding;
  const bytes = new Uint8Array(stride * height).fill(0xa5);
  const view = new DataView(bytes.buffer);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const value = values[y * width + x] ?? 0;
      if (format === 3) bytes[y * stride + x] = value;
      else view.setUint32(y * stride + x * 4, value, true);
    }
  return {
    storage: new BurikoBitmapStorage(bytes, true),
    offset: 0,
    stride,
    width,
    height,
    format,
    bytesPerPixel,
  };
}

function pixels(value) {
  return Array.from({length: value.height}, (_, y) =>
    Array.from({length: value.width}, (_, x) =>
      value.format === 3
        ? value.storage.bytes[value.offset + y * value.stride + x]
        : value.storage.view.getUint32(value.offset + y * value.stride + x * 4, true),
    ),
  ).flat();
}

function signed16(value) {
  return (value << 16) >> 16;
}

function clampByte(value) {
  return Math.max(0, Math.min(255, value));
}

function rgbMaskReference(destination, color, coverage) {
  const coefficient = coverage >= 254 ? 128 : coverage >>> 1;
  if (coefficient === 0) return destination >>> 0;
  if (coefficient === 128) return color & 0xffffff;
  let output = 0;
  for (let shift = 0; shift < 32; shift += 8) {
    const previous = (destination >>> shift) & 255;
    const target = (color >>> shift) & 255;
    output |= clampByte(previous + (signed16((target - previous) * coefficient) >> 7)) << shift;
  }
  return output >>> 0;
}

const floatBits = new DataView(new ArrayBuffer(4));
function reciprocalSeed(input) {
  floatBits.setFloat32(0, input, true);
  const bits = floatBits.getUint32(0, true);
  const exponent = (bits >>> 23) & 255;
  const index = (bits >>> 12) & 2047;
  const normalized = Math.round(8192 / (1 + (index + 0.5) / 2048)) / 8192;
  return Math.fround(normalized * 2 ** (127 - exponent));
}

function weighted(source, destination, sourceWeight, destinationWeight, alpha) {
  let output = alpha << 24;
  for (let shift = 0; shift < 24; shift += 8)
    output |=
      (((Math.imul((source >>> shift) & 255, sourceWeight) +
        Math.imul((destination >>> shift) & 255, destinationWeight)) &
        65535) >>>
        8) <<
      shift;
  return output >>> 0;
}

function rgbaPairReference(destination, color, coverage) {
  const f32 = Math.fround;
  const source = ((coverage << 24) | (color & 0xffffff)) >>> 0;
  const sourceAlpha = f32(coverage);
  const destinationAlpha = f32(f32((destination >>> 24) / 256) * f32(256 - sourceAlpha));
  const alpha = f32(sourceAlpha + destinationAlpha);
  const reciprocal = reciprocalSeed(alpha === 0 ? 1 : alpha);
  return weighted(
    source,
    destination,
    Math.trunc(f32(f32(reciprocal * sourceAlpha) * 256)),
    Math.trunc(f32(f32(reciprocal * destinationAlpha) * 256)),
    Math.trunc(alpha),
  );
}

function rgbaTailReference(destination, color, coverage) {
  const source = ((coverage << 24) | (color & 0xffffff)) >>> 0;
  const sourceAlpha = coverage << 8;
  const destinationAlpha = Math.imul(destination >>> 24, 65536 - sourceAlpha) >>> 8;
  const denominator = (sourceAlpha + destinationAlpha) >>> 0;
  return weighted(
    source,
    destination,
    Math.trunc(((sourceAlpha << 8) >>> 0) / denominator),
    Math.trunc(((destinationAlpha << 8) >>> 0) / denominator),
    denominator >>> 8,
  );
}

test('mask-color dispatcher preserves RGB pair/tail coefficients and RGBA reciprocal distinctions', () => {
  const color = 0x90c030;
  const rgbInput = [0x00112233, 0x7f445566, 0xff102030, 0x40123456, 0x7fabcdef];
  const rgbCoverage = [0, 1, 2, 128, 255];
  const rgb = bitmap(5, 1, rgbInput, 1);
  blendBurikoMaskColor(rgb, bitmap(5, 1, rgbCoverage, 3), color);
  assert.deepEqual(
    pixels(rgb),
    rgbInput.map((pixel, index) => rgbMaskReference(pixel, color, rgbCoverage[index])),
  );
  assert.deepEqual(Array.from(rgb.storage.bytes.slice(20)), [0xa5, 0xa5, 0xa5, 0xa5]);

  const alphaInput = [0x00112233, 0x80445566, 0xff102030, 0x40123456, 0x7fabcdef];
  const alphaCoverage = [0, 64, 255, 7, 128];
  const alpha = bitmap(5, 1, alphaInput, 2);
  blendBurikoMaskColor(alpha, bitmap(5, 1, alphaCoverage, 3), color);
  assert.deepEqual(pixels(alpha), [
    rgbaPairReference(alphaInput[0], color, alphaCoverage[0]),
    rgbaPairReference(alphaInput[1], color, alphaCoverage[1]),
    rgbaPairReference(alphaInput[2], color, alphaCoverage[2]),
    rgbaPairReference(alphaInput[3], color, alphaCoverage[3]),
    rgbaTailReference(alphaInput[4], color, alphaCoverage[4]),
  ]);
  assert.deepEqual(Array.from(alpha.storage.bytes.slice(20)), [0xa5, 0xa5, 0xa5, 0xa5]);
});

test('the shared ordered glyph map owns atlas slices and keeps exact marked lookup keys', () => {
  const {surfaces, state} = setup();
  const values = [0, 1, 2, 3, 4, 5, 10, 11, 12, 13, 14, 15];
  assert.equal(surfaces.importRaw(7, 6, 2, 3, {bytes: Uint8Array.from(values), offset: 0}), 1);
  assert.equal(state.customGlyphs.configureAtlas(3, 7), 0);
  assert.equal(state.customGlyphs.count, 3);
  assert.deepEqual(pixels(state.customGlyphs.snapshot(0x8000f001)), [0, 1, 10, 11]);
  assert.deepEqual(pixels(state.customGlyphs.snapshot(0x8000f002)), [2, 3, 12, 13]);
  assert.deepEqual(pixels(state.customGlyphs.snapshot(0x8000f003)), [4, 5, 14, 15]);
  assert.deepEqual(
    [state.customGlyphs.width(0x8000f001), state.customGlyphs.height(0x8000f001)],
    [2, 2],
  );
  assert.equal(state.customGlyphs.width(0xf001), 0);
  surfaces.fill(7, 255);
  assert.deepEqual(pixels(state.customGlyphs.snapshot(0x8000f001)), [0, 1, 10, 11]);
  state.customGlyphs.clear();
  assert.deepEqual([state.customGlyphs.count, state.customGlyphs.snapshot(0x8000f001)], [0, null]);
});

test('custom glyph fitting colorizes a mask, reduces once and reports native fitted metrics', () => {
  const {surfaces, state} = setup();
  assert.equal(
    surfaces.importRaw(4, 16, 16, 3, {bytes: new Uint8Array(16 * 16).fill(255), offset: 0}),
    1,
  );
  assert.equal(state.customGlyphs.register(0xff01, 4, 0, 0, 16, 16), 0);
  const destination = allocateBurikoBitmap(4, 4, 2);
  clearBurikoBitmap(destination);
  const glyph = state.customGlyphs.draw(
    destination,
    0xf001,
    {size: 4, widthPercent: 100, raster: null},
    0x123456,
    1,
  );
  assert.deepEqual(
    {
      character: glyph.character,
      fullWidth: glyph.fullWidth,
      pixels: glyph.pixels,
      left: glyph.left,
      top: glyph.top,
      right: glyph.right,
      bottom: glyph.bottom,
    },
    {character: 0xf001, fullWidth: 1, pixels: null, left: 0, top: 0, right: 3, bottom: 3},
  );
  assert.deepEqual(pixels(destination), Array(16).fill(0xff123456));
  assert.equal(readRasterText(destination)[0].text, '\uf001');
});

test('embedded decoding retains CP932 pairs and substitutes all three numeric character forms', () => {
  const {text, state} = setup();
  assert.deepEqual(readBurikoEmbeddedCharacter(text, Uint8Array.of(0xf8, 0x80, 0x12, 0x34), 0), {
    value: 0x1234,
    length: 4,
  });
  assert.deepEqual(readBurikoEmbeddedCharacter(text, Uint8Array.of(0xf8, 0xe2, 0x98, 0x83), 0), {
    value: 0x2603,
    length: 4,
  });
  const source = Uint8Array.of(
    0x41,
    0x82,
    0xa0,
    0xef,
    0x40,
    0xff,
    0x12,
    0xf8,
    0x80,
    0x12,
    0x34,
    0xf8,
    0xe2,
    0x98,
    0x83,
    0x5a,
    0,
  );
  assert.equal(state.customGlyphs.decode({bytes: source, offset: 0}), 'Aあ\uef40\uf012\u1234☃Z');
  const control = Uint8Array.of(3, 0xc2, 0xa2, 0);
  assert.equal(text.detectEncoding(control, 0, true), 0);
  assert.equal(decodeBurikoEmbeddedText(text, {bytes: control, offset: 0}), '\u0003¢');
});

test('90 9E and 92 98 consume their native stack shapes without pushing results', async () => {
  const {text, surfaces, state} = setup();
  const definitions = createCustomTextGlyphSettings(state, {
    threadFatal() {
      assert.fail('ordinary custom-glyph service calls should not raise a thread error');
    },
  });
  assert.deepEqual(
    definitions.map((slot) => [slot.primary, slot.secondary]),
    [
      [0x90, 0x9e],
      [0x92, 0x98],
    ],
  );
  for (const slot of definitions)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[slot.primary][slot.secondary]);
  assert.equal(surfaces.importRaw(9, 4, 1, 3, {bytes: Uint8Array.of(1, 2, 3, 4), offset: 0}), 1);
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: new BurikoBpMemory(new Uint8Array(16))};
  async function call(primary, secondary, args) {
    const before = thread.stackIndex;
    for (const argument of args) push32(thread, argument);
    assert.equal(
      await definitions
        .find((definition) => definition.primary === primary && definition.secondary === secondary)
        .execute(context),
      0,
    );
    assert.equal(thread.stackIndex, before);
  }
  await call(0x90, 0x9e, [2, 9]);
  assert.equal(state.customGlyphs.count, 2);
  assert.equal(text.selectMode(1), true);
  await call(0x92, 0x98, [0xf003, 9, 0, 0, 1, 1]);
  assert.equal(state.customGlyphs.count, 3);
  assert.deepEqual(pixels(state.customGlyphs.snapshot(0x8000f003)), [1]);
  assert.equal(isBurikoCustomGlyphCode(0xff01), true);
  assert.equal(isBurikoCustomGlyphCode(0x8000f7ff), true);
  assert.equal(isBurikoCustomGlyphCode(0x8000f800), false);
  await call(0x90, 0x9e, [0, 0xffffffff]);
  assert.equal(state.customGlyphs.count, 0);
});
