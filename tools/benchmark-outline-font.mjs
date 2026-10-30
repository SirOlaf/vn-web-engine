import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';

// Glyph rasterization throughput of `dist/text/freetype.js` for one TrueType or OpenType font,
// in WebAssembly and in the JavaScript fallback. Only coverage hashes and timings are printed.
// Usage: node tools/benchmark-outline-font.mjs <font> [baseline dist] [current dist]
// A baseline dist (for example a build with the previous FreeType) is checked for identical
// glyphs and timed with the same workload.
const [fontPath, baselineDist, currentDist] = process.argv.slice(2);
if (!fontPath)
  throw Error('usage: benchmark-outline-font.mjs <font> [baseline dist] [current dist]');
const font = new Uint8Array(await readFile(fontPath));
const load = async (dist) =>
  (await import(new URL('text/freetype.js', pathToFileURL(resolve(dist) + '/')).href)).FreeType;
const current = await load(currentDist ?? new URL('../dist/', import.meta.url).pathname);
const variants = [
  ['wasm', () => new current()],
  ['javascript', () => new current({wasm: false})],
];
if (baselineDist) {
  const baseline = await load(baselineDist);
  variants.unshift(['baseline', () => new baseline()]);
}

const SIZES = [16, 24, 40];
const GLYPHS = 1500;
const probe = new current().open(font);
const codePoints = [];
for (let cp = 0x21; cp <= 0xffff && codePoints.length < GLYPHS; cp++)
  if (cp < 0xd800 || cp > 0xdfff) {
    probe.requestSize(3, 0, 24 * 64);
    if (probe.rasterize(cp).glyphIndex) codePoints.push(cp);
  }

function run(face, bold) {
  let checksum = 0;
  for (const size of SIZES) {
    face.requestSize(3, 0, size * 64);
    for (const cp of codePoints) {
      const glyph = face.rasterize(cp, {flags: 6, bold});
      checksum = (checksum * 31 + glyph.width * 7 + glyph.advanceX) >>> 0;
      for (let i = 0; i < glyph.pixels.length; i += 7)
        checksum = (checksum + glyph.pixels[i]) >>> 0;
    }
  }
  return checksum;
}

function glyphs(create) {
  const face = create().open(font),
    out = [];
  for (const size of SIZES) {
    face.requestSize(3, 0, size * 64);
    for (const bold of [false, true])
      for (const cp of codePoints) out.push(face.rasterize(cp, {flags: 6, bold}));
  }
  return out;
}

const reference = glyphs(variants[0][1]);
for (const [name, create] of variants.slice(1))
  assert.deepEqual(glyphs(create), reference, name + ' differs from ' + variants[0][0]);

const results = {};
for (const [name, create] of variants)
  for (const bold of [false, true]) {
    const library = create(),
      start = performance.now(),
      face = library.open(font),
      checksum = run(face, bold),
      first = performance.now() - start;
    const samples = [];
    for (let i = 0; i < 5; i++) {
      const t = performance.now();
      assert.equal(run(face, bold), checksum);
      samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    library.close();
    results[`${name}${bold ? ' bold' : ''}`] = {
      firstMs: +first.toFixed(1),
      medianMs: +samples[2].toFixed(1),
    };
  }
console.log(
  JSON.stringify({glyphs: codePoints.length * SIZES.length, sizes: SIZES, results}, null, 1),
);
