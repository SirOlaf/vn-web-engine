import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EmoteRenderer,
  EmoteTextureCache,
  emoteColorGrid,
} from '../dist/native/emotedriver/renderer.js';
import {EmoteUnsupportedError} from '../dist/native/emotedriver/player.js';

// Synthetic draw lists through a host that only tracks texture ids.
function host() {
  const live = new Map();
  let next = 1;
  return {
    live,
    addTexture(image) {
      live.set(next, image);
      return next++;
    },
    removeTexture(id) {
      assert.ok(live.delete(id), `texture ${id} released twice`);
    },
  };
}
const texture = (type = 'L8', width = 8, height = 8) => ({
  type,
  width,
  height,
  pixel: {bytes: new Uint8Array(width * height * 2)},
});
const model = (...textures) => ({
  sources: new Map(textures.map((t, i) => [`s${i}`, {texture: t}])),
});
function item(file, o = {}) {
  return {
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
    ...o,
  };
}
function setup(width = 16, height = 16) {
  const h = host(),
    cache = new EmoteTextureCache(h);
  return {h, cache, renderer: new EmoteRenderer(h, cache, width, height)};
}
const draws = (commands) => commands.filter((c) => c.kind === 'triangles');
const layerCommands = (commands, renderer) => {
  const start = commands.findIndex(
    (c) => c.kind === 'gpu-target' && c.surface === renderer.surface,
  );
  return commands.slice(start);
};

test('the draw list sorts by depth, then clip flags as floats, then list order', () => {
  const {renderer, cache} = setup();
  const file = model(texture(), texture(), texture(), texture());
  const commands = renderer.render(
    [
      item(file, {texIndex: 0, z: 2}),
      item(file, {texIndex: 1, z: 1, clipFlags: 0x3f800000}),
      item(file, {texIndex: 2, z: 1, clipFlags: 0}),
      item(file, {texIndex: 3, z: 1, clipFlags: 0}),
      item(file, {texIndex: 0, z: 0, opa: 0}),
      item(file, {texIndex: 0, z: 0, bm: 6}),
    ],
    false,
  );
  const ids = draws(layerCommands(commands, renderer)).map((d) => d.texture);
  const decoded = [...cache['textures'].values()].map((t) => t.id);
  assert.deepEqual(
    ids,
    [2, 3, 1, 0].map((i) => decoded[i]),
  );
  assert.deepEqual(commands.at(-1), {kind: 'gpu-target', surface: null});
});

test('a frame decodes each atlas once before binding the layer target', () => {
  const {renderer, cache, h} = setup();
  const t = texture('BC7', 8, 8);
  t.pixel.bytes = new Uint8Array(64);
  const commands = renderer.render([item(model(t)), item(model(t))], true);
  const layer = commands.findIndex(
    (c) => c.kind === 'gpu-target' && c.surface === renderer.surface,
  );
  const decode = commands.slice(0, layer);
  assert.equal(decode.length, 2);
  assert.deepEqual(decode[0].clearColor, [0, 0, 0, 0]);
  assert.deepEqual(commands[layer].clearColor, [0, 0, 0, 0]);
  const quads = draws(commands.slice(layer));
  assert.equal(quads.length, 2);
  assert.ok(quads.every((d) => d.filter === 'linear' && d.topology === 'triangle-strip'));
  assert.equal(draws(renderer.render([item(model(t))], true)).length, 1);
  renderer.close();
  cache.close();
  assert.throws(
    () => setup().renderer.render([item(model(texture('RGBA8')))], false),
    EmoteUnsupportedError,
  );
  assert.equal(h.live.size, 0);
});

test('mesh vertices carry swizzled corner colours and texel UVs', () => {
  const {renderer} = setup();
  const colors = Uint32Array.of(0x11223344, 0x55667788, 0x99aabbcc, 0xddeeff00);
  const [quad] = draws(
    layerCommands(
      renderer.render(
        [item(model(texture('L8', 16, 32)), {colors, left: 4, top: 8, width: 8, height: 16})],
        false,
      ),
      renderer,
    ),
  );
  const v = (i) => [...quad.vertices.subarray(i * 9, i * 9 + 9)];
  const rgba = (c) => [
    (c >>> 24) / 255,
    ((c >>> 16) & 255) / 255,
    ((c >>> 8) & 255) / 255,
    (c & 255) / 255,
  ];
  const near = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 1e-6);
  // Strip order: top-left, bottom-left, top-right, bottom-right; item colour 2 is bottom-right.
  assert.ok(near(v(0), [-4, -4, 0, ...rgba(colors[0]), 0.25, 0.25]));
  assert.ok(near(v(1), [-4, 4, 0, ...rgba(colors[3]), 0.25, 0.75]));
  assert.ok(near(v(2), [4, -4, 0, ...rgba(colors[1]), 0.75, 0.25]));
  assert.ok(near(v(3), [4, 4, 0, ...rgba(colors[2]), 0.75, 0.75]));
});

test('the colour grid interpolates edge columns, then rows, in 8-bit fixed point', () => {
  assert.deepEqual([...emoteColorGrid(Uint32Array.of(5, 5, 5, 5), 2, 2)], Array(9).fill(5));
  const grid = emoteColorGrid(Uint32Array.of(0x000000ff, 0xff0000ff, 0x00ff00ff, 0xffffffff), 2, 2);
  assert.deepEqual(
    [...grid].map((c) => c.toString(16).padStart(8, '0')),
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

test('a stencil parent builds the mask before its group draws through it', () => {
  const {renderer} = setup();
  const file = model(texture('A8'), texture());
  const parent = item(file, {stencilType: 2, alphaTest: true, alphaScale: 0.5, alphaOffset: 0.25});
  const commands = layerCommands(
    renderer.render(
      [item(file, {texIndex: 1, stencilParent: parent}), item(file, {texIndex: 1, z: 1})],
      false,
    ),
    renderer,
  );
  const [mask, maskDraw, back, masked, plain] = commands.slice(1);
  assert.equal(mask.kind, 'gpu-target');
  assert.notEqual(mask.surface, renderer.surface);
  assert.deepEqual(mask.clearColor, [1, 1, 1, 1]);
  assert.deepEqual(maskDraw.blendState.color, {
    operation: 'add',
    source: 'zero',
    destination: 'inverse-source-alpha',
  });
  assert.deepEqual([...maskDraw.parameters.subarray(0, 2)], [0.5, 0.25]);
  assert.deepEqual(back, {kind: 'gpu-target', surface: renderer.surface});
  assert.equal(masked.additionalTextures.length, 1);
  assert.equal(plain.additionalTextures, undefined);
});

test('destination blends copy the drawn bounds and address the copy in pixels', () => {
  const {renderer} = setup(16, 16);
  const file = model(texture());
  const bounds = {cols: 1, rows: 1, points: Float32Array.of(-2.5, -4, 3, -4, -2.5, 1.5, 3, 1.5)};
  const commands = layerCommands(
    renderer.render([item(file), item(file, {z: 1, bm: 0x111, grid: bounds})], false),
    renderer,
  );
  const [, , toCopy, copy, back, draw] = commands;
  assert.equal(toCopy.kind, 'gpu-target');
  // Pixels x 5.5..11 → 5..11, y 4..9.5 → 4..10.
  assert.deepEqual([toCopy.surface.width, toCopy.surface.height], [6, 6]);
  assert.deepEqual([...copy.vertices.subarray(0, 9)], [0, 0, 0, 1, 1, 1, 1, 5, 4]);
  assert.deepEqual(back, {kind: 'gpu-target', surface: renderer.surface});
  assert.deepEqual(
    [...draw.parameters.subarray(4, 8)],
    [1 / 6, 1 / 6, -5 / 6, -4 / 6].map(Math.fround),
  );
  assert.equal(draw.parameters[8], 16);
  assert.deepEqual(draw.blendState.alpha, {operation: 'add', source: 'zero', destination: 'one'});
});

test('the blur draws a horizontal and a vertical pass per radius step', () => {
  const {renderer} = setup(16, 16);
  const file = model(texture());
  // Radius int(16 × 0.5 + 0.5) = 8: steps 6 and 2.
  const commands = layerCommands(
    renderer.render([item(file, {bm: 0x11d, bmParam: 0.5})], false),
    renderer,
  );
  const passes = draws(commands).filter((d) => d.additionalTextures);
  assert.equal(passes.length, 4);
  const offsets = passes.map((d) => [...d.parameters.subarray(0, 2)].map((x) => x !== 0));
  assert.deepEqual(offsets, [
    [true, false],
    [false, true],
    [true, false],
    [false, true],
  ]);
  // Copies widen by the pass's tap reach: 4 texels for step 6, 2 for step 2.
  const copies = commands.filter((c) => c.kind === 'gpu-target' && c.surface !== renderer.surface);
  assert.deepEqual([copies[0].surface.width, copies[0].surface.height], [16, 8]);
});
