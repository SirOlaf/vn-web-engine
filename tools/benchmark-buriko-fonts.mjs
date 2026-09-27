import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';

// Generated DIB coverage only; no fonts, game files, browser surfaces, or images are opened.
// Optional argument: a pre-change dist directory, with an ESM package.json above it.
const roots = process.argv[2]
  ? [pathToFileURL(resolve(process.argv[2]) + '/'), new URL('../dist/', import.meta.url)]
  : [new URL('../dist/', import.meta.url)];
const libraries = await Promise.all(
  roots.map(async (root) =>
    Object.assign(
      {},
      ...(await Promise.all(
        ['font-raster', 'font-bitmap', 'bitmap'].map(
          (name) => import(new URL('engines/buriko/native/' + name + '.js', root)),
        ),
      )),
    ),
  ),
);

function fixture(lib, {size = 48, quality = 1, gamma = 0, format = 2, layout = 'ordinary'} = {}) {
  const settings = new lib.BurikoFontRasterSettings();
  settings.setQuality(quality);
  settings.setGamma(gamma);
  const geometry = lib.burikoFontGeometry(size, 100, null, settings);
  const stride = Math.ceil(geometry.dibWidth / 4) * 4;
  const shift = layout === 'unaligned-dib' ? 1 : 0;
  let dib = new Uint8Array(stride * geometry.dibHeight + shift).subarray(shift);
  // Arbitrary nonzero values exercise counting, rather than assuming monochrome 255.
  for (let i = 0; i < dib.length; i++)
    dib[i] = [0, 0, 1, 17, 128, 255, 0][(i * 13 + (i >>> 5)) % 7];
  if (layout === 'short-dib') dib = dib.subarray(0, dib.length - stride - 3);
  const face = {
    cssFamily: 'Synthetic',
    ascent: geometry.fontHeight,
    abc: () => [0, geometry.size * settings.sampleScale, 0],
    extent: () => geometry.size * settings.sampleScale,
    rasterText: () => ({stride, bytes: dib}),
  };
  const raster = new lib.BurikoFontRaster(geometry, face, settings, 2);
  const bitmap = lib.allocateBurikoBitmap(geometry.width, geometry.height, format);
  if (layout === 'short-output') {
    bitmap.storage = new lib.BurikoBitmapStorage(
      bitmap.storage.bytes.subarray(0, bitmap.storage.bytes.length - 3),
      false,
    );
  } else if (layout === 'negative-stride') {
    bitmap.offset = (geometry.height - 1) * bitmap.stride;
    bitmap.stride = -bitmap.stride;
  } else if (layout === 'aliased-glyph') {
    const glyph = raster.glyph(65);
    bitmap.storage = new lib.BurikoBitmapStorage(glyph.pixels, true);
    bitmap.width = Math.floor(geometry.width / 4);
    bitmap.stride = geometry.width;
  }
  return {raster, bitmap};
}

function parity(lib, options) {
  const {raster, bitmap} = fixture(lib, options);
  let glyph,
    error = null;
  try {
    glyph = lib.rasterBurikoGlyph(bitmap, raster, 65, 0x3157a9);
  } catch (failure) {
    error = failure.name + ': ' + failure.message;
  }
  const result = {
    error,
    bytes: bitmap.storage.bytes.slice(),
    initialized: bitmap.storage.initializedRange(0, bitmap.storage.bytes.length),
    glyph: glyph ? {...glyph, pixels: glyph.pixels.slice()} : null,
  };
  bitmap.storage.release();
  return result;
}

const cases = [];
for (const quality of [-1, 0, 1, 2, 3])
  for (const gamma of [0, 1]) cases.push({size: 12, quality, gamma});
for (const format of [0, 1, 2])
  for (const layout of ['ordinary', 'negative-stride', 'short-output', 'aliased-glyph'])
    cases.push({size: 12, format, layout});
for (const layout of ['unaligned-dib', 'short-dib']) cases.push({size: 12, layout});
if (libraries.length === 2)
  for (const options of cases)
    assert.deepEqual(
      parity(libraries[1], options),
      parity(libraries[0], options),
      JSON.stringify(options),
    );

function measure(lib, options, cached) {
  const {raster, bitmap} = fixture(lib, options);
  raster.glyph(65);
  const samples = [];
  for (let run = 0; run < 6; run++) {
    const start = performance.now();
    for (let i = 0; i < 32; i++)
      lib.rasterBurikoGlyph(bitmap, raster, cached ? 65 : 65 + (i % 26), 0x3157a9);
    const elapsed = performance.now() - start;
    if (run > 0) samples.push(elapsed);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  bitmap.storage.release();
  return {medianMs: +sorted[2].toFixed(3), samplesMs: samples.map((value) => +value.toFixed(3))};
}
const workloads = [
  {name: '32 cached RGBA glyph draws', options: {size: 48, quality: 1}, cached: true},
  {
    name: '32 uncached RGBA glyph draws, 4x supersampling',
    options: {size: 48, quality: 1},
    cached: false,
  },
  {
    name: '32 uncached RGBA glyph draws, 16x supersampling',
    options: {size: 32, quality: 3},
    cached: false,
  },
];
console.log(
  JSON.stringify(
    {
      generatedInputsOnly: true,
      measurement:
        'Node wall time for the complete native raster/cache and bitmap draw, including generated DIB processing; excludes actual browser font rasterization. One warm-up and five measured batches per workload. Each batch draws 32 glyphs.',
      parity: {
        independentBaseline: libraries.length === 2,
        cases: libraries.length === 2 ? cases.length : 0,
      },
      workloads: workloads.map((workload) => ({
        name: workload.name,
        results: libraries.map((lib) => measure(lib, workload.options, workload.cached)),
      })),
    },
    null,
    2,
  ),
);
