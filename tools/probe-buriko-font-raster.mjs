import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {
  parseSyntheticBrowserOptions,
  runSyntheticBrowserProbe,
} from './lib/synthetic-browser-probe.mjs';

/**
 * Compares BurikoBrowserFontFace glyph DIBs with the reference raster: a fresh main-thread
 * canvas and context per glyph, thresholding each RGBA alpha byte. Each case checks the
 * in-thread path (one reused canvas) and the worker path (`prefetchText`, then `rasterText`
 * consuming the worker result). Faces cover a resource font loaded from bytes, as game fonts
 * are, and the generic fallback family, with horizontal scales below and above 1 and several
 * supersampled sizes. Glyph order is shuffled so stale ink from a reused canvas would show.
 * `differing` counts DIB bytes; `unused` counts worker results rasterText did not consume.
 */
async function pageMain(fixture, options) {
  const [{BurikoBrowserFontFace}] = await Promise.all([
    import('/runtime/engines/buriko/native/font-browser.js'),
  ]);
  const fontBytes = Uint8Array.from(atob(fixture.font), (c) => c.charCodeAt(0));
  const descriptors = {weight: '400', style: 'normal'};
  const resource = new FontFace('ProbeResourceFont', fontBytes.slice().buffer, descriptors);
  await resource.load();
  document.fonts.add(resource);
  const families = [
    ['ProbeResourceFont', {kind: 'bytes', bytes: fontBytes, descriptors}],
    ['sans-serif', {kind: 'generic'}],
  ];
  const text = [
    ...'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわをん',
    ...'アイウエオガギグゲゴパピプペポャュョッー',
    ...'漢字表示確認蒼彼方四重奏空飛魚翼風景色夢',
    ...'「」『』（）、。！？…―～♪☆♡♥—',
    ...'AgjQWMiyl0123456789.,;:!?"\'()[]{}',
    '——',
  ];
  let seed = 0x9e3779b9;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  function reference(face, value, width, height) {
    const canvas = new OffscreenCanvas(width, height),
      target = canvas.getContext('2d', {willReadFrequently: true});
    target.font = face.metricsContext.font;
    target.fontKerning = 'none';
    target.textBaseline = 'alphabetic';
    target.fillStyle = '#000';
    target.scale(face.horizontalScale, 1);
    target.fillText(value, 0, face.ascent);
    const rgba = target.getImageData(0, 0, width, height).data,
      stride = Math.ceil(width / 4) * 4,
      bytes = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        bytes[y * stride + x] = rgba[(y * width + x) * 4 + 3] >= 128 ? 255 : 0;
    return {bytes, stride};
  }
  function compare(expected, actual) {
    if (actual.stride !== expected.stride || actual.bytes.length !== expected.bytes.length)
      return expected.bytes.length;
    let differing = 0;
    for (let byte = 0; byte < expected.bytes.length; byte++)
      if (actual.bytes[byte] !== expected.bytes[byte]) differing++;
    return differing;
  }
  const sizes = options.smoke ? [24] : [18, 24, 33, 42];
  const results = [];
  for (const [family, workerSource] of families)
    for (const size of sizes)
      for (const widthPercent of [50, 100, 140])
        for (const sampleScale of options.smoke ? [16] : [1, 4, 16]) {
          const width = Math.trunc((size * widthPercent * 2) / 100) * sampleScale,
            height = Math.trunc((size * 3) / 2) * sampleScale;
          const face = new BurikoBrowserFontFace(
            {
              face: family,
              height: size * sampleScale,
              width: (Math.trunc((size * widthPercent) / 100) * sampleScale) >> 1,
              weight: random() & 1 ? 700 : 100,
              italic: false,
              charset: 128,
              pitchAndFamily: 0,
            },
            family,
            family,
            family,
            null,
            workerSource,
          );
          const order = text.map(() => text[(random() >>> 8) % text.length]);
          let differing = 0,
            ink = 0;
          for (const value of order) {
            const expected = reference(face, value, width, height);
            for (const byte of expected.bytes) ink += byte >>> 7;
            differing += compare(expected, face.rasterText(value, width, height));
          }
          // Worker path: every prefetched DIB must be consumed and equal the reference.
          const unique = [...new Set(order)];
          const pending = face.prefetchText(unique, width, height);
          if (pending === null) throw new Error('Worker rasterization is unavailable');
          await pending;
          const prefetched = face.prefetched.size;
          let workerDiffering = 0;
          for (const value of unique)
            workerDiffering += compare(
              reference(face, value, width, height),
              face.rasterText(value, width, height),
            );
          results.push({
            family,
            size,
            widthPercent,
            sampleScale,
            horizontalScale: Math.round(face.horizontalScale * 1000) / 1000,
            width,
            height,
            glyphs: order.length,
            ink,
            differing,
            workerGlyphs: unique.length,
            prefetched,
            unused: face.prefetched.size,
            workerDiffering,
          });
        }
  const sum = (key) => results.reduce((total, result) => total + result[key], 0);
  return {
    userAgent: navigator.userAgent,
    cases: results.length,
    differing: sum('differing'),
    workerDiffering: sum('workerDiffering'),
    missingPrefetches: sum('workerGlyphs') - sum('prefetched'),
    unused: sum('unused'),
    results,
  };
}

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: node tools/probe-buriko-font-raster.mjs [--font path.ttf] [--browser path] [--output results.json] [--smoke]',
  );
  console.log(
    'Compares Buriko browser glyph rasterization, in-thread and on workers, with the fresh-canvas reference. Build dist first with npm run build:runtime.',
  );
} else {
  try {
    const fontIndex = args.indexOf('--font');
    const fontPath =
      fontIndex >= 0
        ? args.splice(fontIndex, 2)[1]
        : '/System/Library/Fonts/Supplemental/Arial Unicode.ttf';
    await runSyntheticBrowserProbe({
      options: parseSyntheticBrowserOptions(args),
      fixture: {font: (await readFile(fontPath)).toString('base64')},
      pageMain,
      runtimeRoot: fileURLToPath(new URL('../dist/', import.meta.url)),
      name: 'vn-font-raster',
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
