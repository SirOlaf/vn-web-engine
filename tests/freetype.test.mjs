import test from 'node:test';
import assert from 'node:assert/strict';
import {FreeType} from '../dist/text/freetype.js';
import {rectangleFont} from './freetype-fixtures.mjs';

test('FreeType 2.4.8 rasterizes synthetic TrueType outlines with owned bytes and native cell requests', () => {
  const library = new FreeType(),
    input = rectangleFont();
  assert.deepEqual(library.version, [2, 4, 8]);
  const font = library.open(input);
  input.fill(0);
  font.requestSize(3, 0, 32 * 64);
  const metrics = font.metrics;
  assert.equal(metrics.unitsPerEm, 4096);
  assert.equal(metrics.yPpem, 32);
  const glyph = font.rasterize(65);
  assert.equal(glyph.glyphIndex, 2);
  assert.deepEqual(
    [glyph.width, glyph.height, glyph.left, glyph.top, glyph.advanceX, glyph.advanceY],
    [8, 16, 0, 32, 24 * 64, 0],
  );
  assert.equal(glyph.pixels.length, 128);
  assert.ok(glyph.pixels.every((value) => value === 255));
  const old = glyph.pixels.slice();
  font.requestSize(3, 0, 64 * 64);
  const large = font.rasterize(65);
  assert.deepEqual([large.width, large.height], [16, 32]);
  assert.deepEqual(glyph.pixels, old);
  const bold = font.rasterize(65, {bold: true});
  assert.ok(bold.width >= large.width && bold.advanceX >= large.advanceX);
  assert.throws(() => font.rasterize(65, {flags: 2}), /render flag/);
  assert.throws(() => font.rasterize(0xd800), /Unicode/);
  assert.throws(() => font.requestSize(3, 0, 4097 * 64), /integer/);
  assert.throws(() => library.open(Uint8Array.of(0, 1, 2)), /font error/);
  assert.equal(font.rasterize(65).width, 16);
  font.close();
  font.close();
  assert.throws(() => font.rasterize(65), /closed/);
  const replacement = library.open(rectangleFont());
  replacement.requestSize(3, 0, 32 * 64);
  assert.throws(() => font.rasterize(65), /closed/);
  assert.equal(replacement.rasterize(65).width, 8);
  replacement.close();
  library.close();
  library.close();
  assert.throws(() => library.open(rectangleFont()), /closed/);
});

test('FreeType instances and face resources remain isolated across close and size changes', () => {
  const first = new FreeType(),
    second = new FreeType();
  const a = first.open(rectangleFont()),
    b = first.open(rectangleFont()),
    c = second.open(rectangleFont());
  a.requestSize(3, 0, 16 * 64);
  b.requestSize(3, 0, 32 * 64);
  c.requestSize(3, 0, 64 * 64);
  assert.deepEqual(
    [a.rasterize(65).width, b.rasterize(65).width, c.rasterize(65).width],
    [4, 8, 16],
  );
  first.close();
  assert.throws(() => a.rasterize(65), /closed/);
  assert.equal(c.rasterize(65).width, 16);
  second.close();
});

test('Real font worker retains copied input, transfers raster coverage and survives per-font failures', async () => {
  const {Worker} = await import('node:worker_threads');
  const {FreeTypeWorker} = await import('../dist/text/freetype-worker-client.js');
  const service = new FreeTypeWorker(() => {
    const raw = new Worker(new URL('./freetype-node-worker.mjs', import.meta.url));
    const host = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage: (value, transfers) => raw.postMessage(value, transfers),
      terminate: () => raw.terminate(),
    };
    raw.on('message', (data) => host.onmessage?.({data}));
    raw.on('error', (error) => host.onerror?.(error));
    return host;
  });
  try {
    const bytes = rectangleFont(),
      font = await service.open(bytes);
    assert.ok(bytes.byteLength > 0);
    await font.requestSize(3, 0, 32 * 64);
    assert.equal((await font.metrics()).yPpem, 32);
    const [small, large] = await Promise.all([
      font.rasterize(65, {size: {type: 3, width: 0, height: 16 * 64}}),
      font.rasterize(65, {size: {type: 3, width: 0, height: 64 * 64}}),
    ]);
    assert.deepEqual([small.width, large.width], [4, 16]);
    const ownMetrics = await font.requestSize(3, 0, 32 * 64);
    assert.equal(ownMetrics.yPpem, 32);
    const glyph = await font.rasterize(65);
    assert.equal(glyph.width, 8);
    assert.ok(glyph.pixels.every((value) => value === 255));
    await assert.rejects(service.open(Uint8Array.of(0)), /font error/);
    assert.equal((await font.rasterize(65)).height, 16);
    await font.close();
    await font.close();
    assert.throws(() => font.metrics(), /closed/);
    const second = await service.open(rectangleFont());
    await second.requestSize(3, 0, 16 * 64);
    assert.equal((await second.rasterize(65)).width, 4);
    const pending = second.rasterize(65);
    service.close();
    await assert.rejects(pending, /closed/);
    assert.deepEqual(Array.from(glyph.pixels), new Array(128).fill(255));
  } finally {
    service.close();
  }
});

test('WebAssembly and JavaScript rasterizers return identical glyphs', () => {
  const faces = [new FreeType(), new FreeType({wasm: false})].map((library) =>
    library.open(rectangleFont()),
  );
  // Fractional 26.6 sizes leave partially covered edge pixels.
  for (let height = 5 * 64; height <= 80 * 64; height += 157)
    for (const bold of [false, true]) {
      const [wasm, javascript] = faces.map((face) =>
        face.rasterize(65, {bold, size: {type: 3, width: 0, height}}),
      );
      assert.deepEqual(wasm, javascript, `height ${height}, bold ${bold}`);
    }
  assert.throws(() => faces[0].rasterize(65, {flags: 6 | 8}), /Unsupported FreeType load flags/);
});
