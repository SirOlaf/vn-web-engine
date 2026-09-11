import test from 'node:test';
import assert from 'node:assert/strict';
import {buildAtlasFont} from '../dist/text/atlas-font.js';
import {BrowserAtlasFonts} from '../dist/text/browser-atlas-font.js';
const glyph = {
  codePoint: 0x65e5,
  width: 1,
  height: 1,
  advance: 1,
  pixels: new Uint8Array([
    255, 255, 255, 255, 100, 120, 140, 128, 255, 255, 255, 0, 255, 255, 255, 64,
  ]),
  pixelWidth: 2,
  pixelHeight: 2,
  sourceX: 0.5,
  sourceY: 0,
  sourceWidth: 1.5,
  sourceHeight: 2,
};
function tables(buffer) {
  const v = new DataView(buffer),
    out = new Map();
  for (let i = 0; i < v.getUint16(4); i++) {
    const at = 12 + i * 16,
      tag = String.fromCharCode(...new Uint8Array(buffer, at, 4));
    out.set(tag, new DataView(buffer, v.getUint32(at + 8), v.getUint32(at + 12)));
  }
  return out;
}
function checksum(buffer) {
  const a = new DataView(buffer);
  let n = 0;
  for (let i = 0; i < a.byteLength; i += 4) n = (n + a.getUint32(i)) >>> 0;
  return n;
}
test('atlas font preserves Unicode including supplementary planes, palette RGBA and fractional sample bounds', () => {
  const buffer = buildAtlasFont([glyph, {...glyph, codePoint: 0x20000}]),
    t = tables(buffer),
    cmap = t.get('cmap'),
    colr = t.get('COLR'),
    cpal = t.get('CPAL');
  assert.equal(checksum(buffer), 0xb1b0afba);
  assert.equal(t.get('head').getUint16(18), 4096);
  assert.equal(t.get('maxp').byteLength, 32);
  assert.equal(t.get('OS/2').byteLength, 78);
  assert.equal(cmap.getUint16(12), 12);
  assert.equal(cmap.getUint32(24), 2);
  assert.equal(cmap.getUint32(28), 0x65e5);
  assert.equal(cmap.getUint32(40), 0x20000);
  assert.equal(colr.getUint16(2), 2);
  assert.equal(colr.getUint16(12), 6);
  assert.deepEqual(
    [...new Uint8Array(cpal.buffer, cpal.byteOffset + 14, 12)],
    [255, 255, 255, 255, 140, 120, 100, 128, 255, 255, 255, 64],
  );
  const layerOffset = colr.getUint32(8),
    layerId = colr.getUint16(layerOffset),
    offset = t.get('loca').getUint32(layerId * 4),
    outline = t.get('glyf');
  // First opaque source sample is clipped from [0,1] to [.5,1].
  assert.equal(outline.getInt16(offset), 1);
  assert.equal(outline.getInt16(offset + 2), 0);
  assert.equal(outline.getInt16(offset + 4), 2048);
  assert.equal(outline.getInt16(offset + 6), 1365);
  assert.equal(outline.getInt16(offset + 8), 4096);
});
test('transparent samples remain empty advance glyphs; malformed and ambiguous cmap inputs are rejected', () => {
  const t = tables(buildAtlasFont([{...glyph, codePoint: 32, pixels: new Uint8Array(16)}]));
  assert.equal(t.get('COLR').getUint16(2), 0);
  assert.equal(t.get('glyf').byteLength, 0);
  assert.equal(t.get('hmtx').getUint16(4), 4096);
  assert.throws(() => buildAtlasFont([glyph, glyph]));
  assert.throws(() => buildAtlasFont([{...glyph, sourceX: -1}]));
  assert.throws(() =>
    buildAtlasFont(Array.from({length: 33}, (_, codePoint) => ({...glyph, codePoint}))),
  );
});
const flush = () => new Promise((r) => setImmediate(r));
test('runtime font readiness, cache, alpha-only sampling, cmap conflicts and disposal', async () => {
  const originals = {
    Worker: globalThis.Worker,
    FontFace: globalThis.FontFace,
    document: globalThis.document,
  };
  const workers = [],
    faces = new Set();
  class Worker {
    requests = [];
    constructor() {
      workers.push(this);
    }
    postMessage(data) {
      this.requests.push(data);
    }
    terminate() {
      this.terminated = true;
    }
    complete(i = 0) {
      const data = this.requests[i];
      this.onmessage({data: {id: data.id, buffer: buildAtlasFont(data.glyphs)}});
    }
  }
  class FontFace {
    constructor(family, buffer, options) {
      this.family = family;
      this.buffer = buffer;
      this.options = options;
    }
    async load() {
      return this;
    }
  }
  Object.assign(globalThis, {Worker, FontFace, document: {fonts: faces}});
  try {
    let ready = 0;
    const fonts = new BrowserAtlasFonts(() => ready++),
      image = {width: 2, height: 2, pixels: glyph.pixels},
      images = new Map([[91, image]]),
      g = {
        id: 1,
        text: '日',
        line: 0,
        x: 0,
        y: 0,
        width: 48,
        height: 48,
        color: 0xffffff,
        alpha: 255,
        raster: {texture: 91, source: {x: 0, y: 0, width: 2, height: 2}, alphaOnly: true},
      },
      slot = {id: 'body', glyphs: [g]};
    assert.equal(fonts.request(slot, images), undefined);
    assert.equal(fonts.request(slot, images), undefined);
    assert.equal(workers[0].requests.length, 1);
    const submitted = workers[0].requests[0].glyphs;
    assert.equal(submitted[0].pixels[4], 255);
    assert.equal(submitted[0].pixels[7], 128);
    assert.ok(submitted.some((g) => g.codePoint === 32));
    workers[0].complete();
    await flush();
    assert.equal(ready, 1);
    const family = fonts.request(slot, images);
    assert.match(family, /^GameAtlas/);
    assert.equal(faces.size, 1);
    assert.equal(
      fonts.request({...slot, glyphs: [{...g, alpha: 50, x: 100, color: 0}]}, images),
      family,
    );
    const many = {
      id: 'many',
      glyphs: Array.from({length: 40}, (_, i) => ({
        ...g,
        text: String.fromCodePoint(0x1000 + i),
        x: i * 48,
      })),
    };
    assert.equal(fonts.request(many, images), undefined);
    assert.equal(workers[0].requests.length, 2, 'only the first subset is dispatched');
    workers[0].complete(1);
    await flush();
    assert.equal(
      fonts.request(many, images),
      undefined,
      'one loaded subset must not replace the native slot',
    );
    assert.equal(workers[0].requests.length, 3);
    workers[0].complete(2);
    await flush();
    const manyFamily = fonts.request(many, images);
    assert.match(manyFamily, /^GameAtlas/);
    assert.equal([...faces].filter((f) => f.family === manyFamily).length, 2);
    assert.equal(ready, 2);
    assert.equal(fonts.request({...slot, glyphs: [g, {...g, width: 24}]}, images), undefined);
    assert.equal(fonts.request({...slot, glyphs: [{...g, raster: undefined}]}, images), undefined);
    assert.equal(fonts.request(slot, new Map([[91, {...image}]])), undefined);
    fonts.clear();
    workers[0].complete(3);
    await flush();
    assert.equal(faces.size, 0);
    assert.equal(ready, 2);
    assert.equal(workers[0].terminated, true);
  } finally {
    Object.assign(globalThis, originals);
  }
});
test('font raster sidecars resolve texture updates at each native draw, including compiled glyphs', async () => {
  const {tagGlyph, collectTextFrame, transferTextDraw} =
    await import('../dist/engines/mages/games/chaos-head-noah/sc3/dom-text-data.js');
  const a = {width: 2, height: 2, pixels: new Uint8Array(16)},
    b = {...a, pixels: new Uint8Array(16).fill(255)},
    source = {x: 0.5, y: 0, width: 1.5, height: 2},
    commands = [];
  for (let i = 0; i < 2; i++) {
    if (i) commands.push({kind: 'texture', texture: 91, image: b});
    const draw = {
      texture: 91,
      source,
      destination: {x: i * 48, y: 0, width: 48, height: 48},
      color: 0xffffff,
      alpha: 255,
    };
    tagGlyph(draw, 'body', i, 1, {role: 'body', line: 0}, draw.destination, draw.color, draw.alpha);
    const compiled = {kind: 'triangles', texture: 91, vertices: new Float32Array()};
    transferTextDraw(draw, compiled);
    commands.push(compiled);
  }
  const plan = collectTextFrame(commands, undefined, new Map([[91, a]])),
    buffer = plan.slots[0].glyphs;
  assert.equal(buffer[0].raster.image, a);
  assert.equal(buffer[1].raster.image, b);
  assert.deepEqual(buffer[0].raster.source, source);
  assert.equal(plan.omitSlots.get(commands[0]), 'body/body');
  assert.equal(plan.omitSlots.get(commands[2]), 'body/body');
});
