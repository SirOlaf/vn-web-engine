import test from 'node:test';
import assert from 'node:assert/strict';
import {EmoteD3d11Renderer} from '../dist/native/emotedriver/runtime/render/renderer-d3d11.js';
import {EmoteD3d11Textures} from '../dist/native/emotedriver/runtime/render/d3d11-textures.js';
import {EmoteD3d11Shaders} from '../dist/native/emotedriver/runtime/render/d3d11-shaders.js';
import {emoteGridColors} from '../dist/native/emotedriver/runtime/render/vertex-colors.js';
import {nativeHost, shaderStandins} from './emotedriver-d3d11-fixture.mjs';

const texture = (type = 'L8', width = 8, height = 8, value = 0) => ({
  type,
  width,
  height,
  pixel: {bytes: new Uint8Array(width * height * 4).fill(value)},
});
const model = (...textures) => ({
  spec: 'win',
  sources: new Map(textures.map((texture, i) => ['s' + i, {texture}])),
});
const item = (file, changes = {}) => ({
  blank: false,
  clipFlags: 0,
  bm: 0x10,
  bmParam: 0,
  grayscaleMode: 0,
  grayscaleLevel: 0,
  z: 0,
  texIndex: 0,
  file,
  attr: 0,
  left: 0,
  top: 0,
  width: 8,
  height: 8,
  opa: 255,
  colors: Uint32Array.of(0x808080ff, 0x808080ff, 0x808080ff, 0x808080ff),
  grid: {cols: 1, rows: 1, points: Float32Array.of(-4, -4, 4, -4, -4, 4, 4, 4)},
  stencilType: 0,
  alphaTest: false,
  alphaScale: 1,
  alphaOffset: 0,
  stencilParent: null,
  composite: [],
  ...changes,
});
function setup(t, width = 16, height = 16) {
  const h = nativeHost({recordAll: true}),
    shaders = new EmoteD3d11Shaders(h.device, shaderStandins({constants: true})),
    textures = new EmoteD3d11Textures(h.device),
    renderer = new EmoteD3d11Renderer(h.device, h.context, shaders, textures),
    out = h.device.createTexture2D({width, height, format: 28, bindFlags: 40}, null).value,
    view = h.device.createRenderTargetView(out, null).value;
  const matrix = Float32Array.of(2 / width, 0, 0, 0, 0, -2 / height, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1),
    target = {texture: out, view, depth: null, width, height, subresource: 0};
  t.after(() => {
    renderer.dispose();
    textures.dispose();
    shaders.dispose();
    h.context.clearState();
    view.release();
    out.release();
    h.context.release();
    h.device.release();
    assert.ok(
      h.created.every((r) => r.references === 0),
      'Every owned/bound Native reference retired',
    );
  });
  return {
    ...h,
    renderer,
    target,
    render: (items, smoothing = false) => renderer.render(items, target, matrix, smoothing),
    draws: () => h.calls.filter((c) => c.method === 'draw'),
  };
}
const floats = (draw, offset, count) =>
  Array.from({length: count}, (_, i) =>
    new DataView(
      draw.constants.buffer,
      draw.constants.byteOffset,
      draw.constants.byteLength,
    ).getFloat32(offset + i * 4, true),
  );

test('native draw order uses depth, float clip flags and stable list order', (t) => {
  const h = setup(t),
    file = model(...[0, 1, 2, 3, 4].map((n) => texture('L8', 8, 8, n)));
  h.render([
    item(file, {texIndex: 0, z: 2}),
    item(file, {texIndex: 1, z: 1, clipFlags: 0x3f800000}),
    item(file, {texIndex: 2, z: 1}),
    item(file, {texIndex: 3, z: 1}),
    item(file, {texIndex: 4, z: 1, clipFlags: 0xbf800000}),
    item(file, {opa: 0}),
    item(file, {bm: 6}),
  ]);
  const sources = h.draws().map((d) => {
    const source = d.source[0].getResource();
    try {
      return source.data[0];
    } finally {
      source.release();
    }
  });
  assert.deepEqual(sources, [4, 2, 3, 1, 0]);
});

test('native atlas upload occurs once before target binding and is retained between frames', (t) => {
  const h = setup(t),
    atlas = texture('BC7'),
    file = model(atlas);
  atlas.pixel.bytes = new Uint8Array(64);
  h.render([item(file), item(file)], true);
  const uploads = h.calls.filter((c) => c.method === 'texture' && c.value.desc.bindFlags === 8);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].value.desc.format, 98);
  assert.deepEqual(uploads[0].value.data, atlas.pixel.bytes);
  assert.ok(
    h.calls.indexOf(uploads[0]) < h.calls.findIndex((c) => c.method === 'omSetRenderTargets'),
  );
  assert.equal(h.draws().length, 2);
  h.render([item(file)], true);
  assert.equal(
    h.calls.filter((c) => c.method === 'texture' && c.value.desc.bindFlags === 8).length,
    1,
  );
});

test('native mesh vertices preserve packed corner colours and normalized texel UVs', (t) => {
  const h = setup(t),
    colors = Uint32Array.of(0x11223344, 0x55667788, 0x99aabbcc, 0xddeeff00);
  h.render([item(model(texture('L8', 16, 32)), {colors, left: 4, top: 8, width: 8, height: 16})]);
  const bytes = h.calls.find((c) => c.method === 'vertices').bytes,
    v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const actual = Array.from({length: 4}, (_, i) => [
    v.getFloat32(i * 20, true),
    v.getFloat32(i * 20 + 4, true),
    v.getUint32(i * 20 + 8, true),
    v.getFloat32(i * 20 + 12, true),
    v.getFloat32(i * 20 + 16, true),
  ]);
  assert.deepEqual(actual, [
    [-4, -4, 0x44112233, 0.25, 0.25],
    [-4, 4, 0x00ddeeff, 0.25, 0.75],
    [4, -4, 0x88556677, 0.75, 0.25],
    [4, 4, 0xcc99aabb, 0.75, 0.75],
  ]);
});

test('shared native colour interpolation preserves the fixed-point grid', () => {
  assert.deepEqual([...emoteGridColors(Uint32Array.of(5, 5, 5, 5), 2, 2)], Array(9).fill(5));
  assert.deepEqual(
    [...emoteGridColors(Uint32Array.of(0x000000ff, 0xff0000ff, 0x00ff00ff, 0xffffffff), 2, 2)].map(
      (v) => v.toString(16).padStart(8, '0'),
    ),
    [
      '000000ff',
      '7f0000ff',
      'ff0000ff',
      '007f00ff',
      '7f7f3fff',
      'ff7f7fff',
      '00ff00ff',
      '7fff7fff',
      'ffffffff',
    ],
  );
});

test('native alpha masks draw the parent before the masked group and clear the following binding', (t) => {
  const h = setup(t),
    file = model(texture('A8'), texture()),
    parent = item(file, {stencilType: 2, alphaTest: true, alphaScale: 0.5, alphaOffset: 0.25});
  h.render([item(file, {texIndex: 1, stencilParent: parent}), item(file, {texIndex: 1, z: 1})]);
  const [mask, masked, plain] = h.draws();
  assert.equal(h.draws().length, 3);
  assert.notEqual(mask.target, h.target.view);
  assert.equal(masked.target, h.target.view);
  assert.equal(plain.target, h.target.view);
  assert.ok(
    h.calls.some((c) => c.method === 'clearRenderTargetView' && c.args[1].every((v) => v === 1)),
  );
  assert.deepEqual([mask.blend.srcBlend, mask.blend.destBlend], [1, 6]);
  assert.deepEqual(floats(mask, 96, 2), [0.5, 0.25]);
  assert.ok(masked.source[1]);
  assert.equal(plain.source[1], null);
});

test('native destination blends copy exact pixel bounds and bind the copied resource', (t) => {
  const h = setup(t),
    file = model(texture()),
    grid = {cols: 1, rows: 1, points: Float32Array.of(-2.5, -4, 3, -4, -2.5, 1.5, 3, 1.5)};
  h.render([item(file), item(file, {z: 1, bm: 0x111, grid})]);
  const copy = h.calls.find((c) => c.method === 'copySubresourceRegion'),
    [destination, sub, x, y, z, source, sourceSub, box] = copy.args;
  assert.deepEqual([sub, x, y, z, sourceSub], [0, 0, 0, 0, 0]);
  assert.equal(source, h.target.texture);
  assert.deepEqual(box, {left: 5, top: 4, right: 11, bottom: 10, front: 0, back: 1});
  assert.deepEqual([destination.desc.width, destination.desc.height], [6, 6]);
  const draw = h.draws().at(-1),
    sampled = draw.source[2].getResource();
  assert.equal(sampled, destination);
  sampled.release();
  assert.deepEqual(floats(draw, 112, 4), [1 / 6, 1 / 6, -5 / 6, -4 / 6].map(Math.fround));
  assert.deepEqual([draw.blend.srcBlendAlpha, draw.blend.destBlendAlpha], [1, 2]);
});

test('native blur submits horizontal and vertical passes for both radius steps', (t) => {
  const h = setup(t),
    file = model(texture());
  h.render([item(file, {bm: 0x11d, bmParam: 0.5})]);
  const draws = h.draws();
  assert.equal(draws.length, 4);
  assert.deepEqual(
    draws.map((d) => floats(d, 128, 2).map((v) => v !== 0)),
    [
      [true, false],
      [false, true],
      [true, false],
      [false, true],
    ],
  );
  const copies = h.calls.filter((c) => c.method === 'copySubresourceRegion');
  assert.equal(copies.length, 4);
  const first = copies[0].args[7];
  assert.deepEqual([first.right - first.left, first.bottom - first.top], [16, 8]);
});
