import test from 'node:test';
import assert from 'node:assert/strict';
import {allocateAokanaBitmap} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {clearAokanaBitmap} from '../dist/engines/buriko/games/aokana/native/bitmap-copy.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {
  AokanaFontRaster,
  AokanaFontRasterSettings,
  aokanaFontGeometry,
} from '../dist/engines/buriko/games/aokana/native/font-raster.js';
import {aokanaTextOutlineWeightTables} from '../dist/engines/buriko/games/aokana/native/font-outline.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaTextLayoutState} from '../dist/engines/buriko/games/aokana/native/text-layout-state.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

function setup() {
  const text = new AokanaNativeText();
  const fonts = new AokanaNativeFonts(text);
  const compositor = new AokanaBitmapCompositor();
  const surfaces = new AokanaSurfaces(fonts, compositor, new AokanaDistributedAllocator(1));
  return {surfaces, state: new AokanaTextLayoutState(surfaces)};
}

function pixels(bitmap) {
  return Array.from({length: bitmap.height}, (_, y) =>
    Array.from({length: bitmap.width}, (_, x) =>
      bitmap.storage.view.getUint32(bitmap.offset + y * bitmap.stride + x * 4, true),
    ),
  ).flat();
}

function syntheticFont(character = 65) {
  const settings = new AokanaFontRasterSettings();
  settings.setQuality(-1);
  const geometry = aokanaFontGeometry(4, 100, null, settings);
  const face = {
    ascent: 4,
    abc() {
      return [0, 2, 0];
    },
    extent() {
      return 2;
    },
    rasterText(_text, width, height) {
      return {stride: width, bytes: new Uint8Array(width * height)};
    },
  };
  const raster = new AokanaFontRaster(geometry, face, settings, 2);
  const glyph = raster.glyph(character);
  return {
    glyph,
    geometry,
    font: {
      id: 1,
      name: new Uint8Array(),
      size: 4,
      widthPercent: 100,
      bold: 0,
      raster,
      initializationResult: 0,
      field44: 0,
      field48: 0,
      averageWidthThreshold: 0,
    },
  };
}

function pixel(alpha, color) {
  return ((alpha << 24) | color) >>> 0;
}

test('startup exposes five distinct radial Q16 tables with the native discontinuous weights', () => {
  const tables = aokanaTextOutlineWeightTables();
  assert.equal(aokanaTextOutlineWeightTables(), tables);
  assert.deepEqual(
    tables.map((table) => table.length),
    [9, 25, 49, 81, 121],
  );
  assert.equal(new Set(tables.map((table) => table.buffer)).size, 5);
  const at = (radius, dx, dy) => {
    const side = radius * 2 + 1;
    return tables[radius - 1][(dy + radius) * side + dx + radius];
  };
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((radius) => at(radius, 0, 0)),
    [65536, 65536, 65536, 65536, 65536],
  );
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((radius) => at(radius, radius, 0)),
    [65536, 65536, 65536, 65536, 65536],
  );
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((radius) => at(radius, radius, 1)),
    [27145, 15470, 10635, 8067, 6489],
  );
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((radius) => at(radius, radius, radius)),
    [27145, 54291, 0, 0, 0],
  );
});

test('ordinary equal-radius outline reads the cached glyph table path and ORs the raw color', () => {
  const {state} = setup();
  const {font, glyph, geometry} = syntheticFont();
  glyph.pixels.fill(0);
  glyph.pixels[geometry.stride + 1] = 255;
  const destination = allocateAokanaBitmap(5, 5, 2);
  const color = 0x80010203;
  state.drawGlyphOutline(destination, 65, font, 1, 1, color);
  const expected = Array(25).fill(color);
  expected.splice(6, 3, pixel(105, color), pixel(255, color), pixel(105, color));
  expected.splice(11, 3, pixel(255, color), pixel(255, color), pixel(255, color));
  expected.splice(16, 3, pixel(105, color), pixel(255, color), pixel(105, color));
  assert.deepEqual(pixels(destination), expected);
  assert.equal(font.raster.glyph(65), glyph);
});

test('ordinary unequal positive radii use the binary64 ellipse path', () => {
  const {state} = setup();
  const {font, glyph} = syntheticFont();
  glyph.pixels.fill(0);
  glyph.pixels[0] = 255;
  const destination = allocateAokanaBitmap(5, 3, 2);
  const color = 0x123456;
  state.drawGlyphOutline(destination, 65, font, 2, 1, color);
  assert.deepEqual(
    pixels(destination),
    [105, 30, 255, 30, 105, 255, 255, 255, 255, 255, 105, 30, 255, 30, 105].map((alpha) =>
      pixel(alpha, color),
    ),
  );
});

test('unfitted custom outline sums the shared format-three bitmap over the shifted box', () => {
  const {surfaces, state} = setup();
  assert.equal(
    surfaces.importRaw(7, 2, 2, 3, {bytes: Uint8Array.of(200, 100, 80, 40), offset: 0}),
    1,
  );
  assert.equal(state.customGlyphs.register(0xff01, 7, 0, 0, 2, 2), 0);
  const destination = allocateAokanaBitmap(4, 4, 2);
  const font = {size: 4, widthPercent: 100, raster: null};
  state.drawGlyphOutline(destination, 0xf001, font, 1, 1, 0x102030);
  assert.deepEqual(
    pixels(destination),
    [200, 255, 255, 100, 255, 255, 255, 140, 255, 255, 255, 140, 80, 120, 120, 40].map((alpha) =>
      pixel(alpha, 0x102030),
    ),
  );
});

test('fitted custom outline sums the alpha produced by the actual shared glyph draw path', () => {
  const {surfaces, state} = setup();
  const mask = Uint8Array.from({length: 16 * 16}, (_, index) => {
    const x = index % 16;
    const y = Math.trunc(index / 16);
    return (x * 11 + y * 7) & 255;
  });
  assert.equal(surfaces.importRaw(8, 16, 16, 3, {bytes: mask, offset: 0}), 1);
  assert.equal(state.customGlyphs.register(0xff02, 8, 0, 0, 16, 16), 0);
  state.field1D1D94 = 1;
  const font = {size: 4, widthPercent: 100, raster: null};
  const fitted = allocateAokanaBitmap(4, 4, 2);
  clearAokanaBitmap(fitted);
  const glyph = state.customGlyphs.draw(fitted, 0xf002, font, 0, state.field1D1D94);
  const fittedWidth = glyph.right + 1;
  const fittedHeight = glyph.bottom + 1;
  const expected = [];
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++) {
      let sum = 0;
      for (let sourceY = Math.max(0, y - 2); sourceY <= Math.min(y, fittedHeight - 1); sourceY++)
        for (let sourceX = Math.max(0, x - 2); sourceX <= Math.min(x, fittedWidth - 1); sourceX++)
          sum += fitted.storage.bytes[fitted.offset + sourceY * fitted.stride + sourceX * 4 + 3];
      expected.push(pixel(Math.min(sum, 255), 0x050607));
    }
  assert.ok(new Set(expected).size > 1);
  const destination = allocateAokanaBitmap(4, 4, 2);
  state.drawGlyphOutline(destination, 0xf002, font, 1, 1, 0x050607);
  assert.deepEqual(pixels(destination), expected);
  fitted.storage.release();
});
