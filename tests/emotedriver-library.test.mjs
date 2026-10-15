import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeLibraryLoader} from '../dist/platform/native-libraries.js';
import {EMOTE_PSB_KEYS, decryptPsbBody} from '../dist/formats/kirikiri/psb-filter.js';
import {EMOTE_DRIVER} from '../dist/native/emotedriver/contract.js';
import {emoteDriverLibrary} from '../dist/native/emotedriver/library.js';
import {buildPsb, emoteWinTree, resource} from './kirikiri-psb-fixtures.mjs';

const SHA256 = 'a3b693b605d67812e489b1fb62cd341012b5514fc9114a032fee4685e70b3a86';
const KEY = EMOTE_PSB_KEYS.get(SHA256);

/** The synthetic win tree with full-size texture levels, filtered as shipped. */
function motionFile(type = 'DXT5') {
  const tree = emoteWinTree();
  const texture = tree.source.tex.texture;
  // A root keyframe, as in shipped files (a layer without frames hides its subtree).
  tree.object.all_parts.motion.base.layer[0].frameList = [{time: 0, type: 2, content: {mask: 0}}];
  // Draw priorities as shipped: one value per layer (node index − 1), closed at lastTime.
  tree.object.all_parts.motion.base.priority = [
    {time: 0, type: 1, content: [2, 1, 0]},
    {time: 61, type: 1, content: null},
  ];
  const bytes = (w, h) => (type === 'DXT5' ? (w / 4) * (h / 4) * 16 : w * h * 4);
  texture.type = type;
  texture.pixel = resource(new Uint8Array(bytes(256, 128)).fill(0x11));
  texture.mipMap = [{width: 128, height: 64, pixel: resource(new Uint8Array(bytes(128, 64)))}];
  return decryptPsbBody(buildPsb(tree), KEY);
}

/** `IDirect3DDevice9` that answers every call and records draws. */
function device() {
  const ok = (value) => ({hr: 0, value});
  const object = () => ({addRef: () => 1, release: () => 0});
  const states = new Map();
  const draws = [];
  let references = 1;
  return {
    draws,
    get references() {
      return references;
    },
    addRef: () => ++references,
    release: () => --references,
    testCooperativeLevel: () => 0,
    getDirect3D: () =>
      ok({
        ...object(),
        getAdapterDisplayMode: () => ok({width: 1280, height: 720, refreshRate: 60, format: 22}),
        checkDeviceFormat: (_a, _t, _f, _u, _r, format) => (format === 0x35545844 ? 0 : -1),
      }),
    getDeviceCaps: () =>
      ok({
        maxTextureWidth: 4096,
        maxTextureHeight: 4096,
        textureCaps: 0x4000,
        vertexShaderVersion: 0xfffe0000,
        pixelShaderVersion: 0xffff0000,
      }),
    getDisplayMode: () => ok({width: 1280, height: 720, refreshRate: 60, format: 22}),
    createTexture: (width, height, levels, usage, format) =>
      ok({
        ...object(),
        getLevelDesc: () => ok({format, usage, pool: 0, width, height}),
        getSurfaceLevel: () => ok({...object(), getDesc: () => ({width, height})}),
        lockRect: (level) =>
          ok({pitch: 0, bits: new Uint8Array(Math.max(16, (width * height * 4) >> (2 * level)))}),
        unlockRect: () => 0,
      }),
    setRenderTarget: () => 0,
    getRenderTarget: () =>
      ok({...object(), getDesc: () => ({format: 21, usage: 1, pool: 0, width: 1280, height: 720})}),
    clear: () => 0,
    setTransform: () => 0,
    getTransform: () => ok(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])),
    setViewport: () => 0,
    getViewport: () => ok({x: 0, y: 0, width: 1280, height: 720, minZ: 0, maxZ: 1}),
    setRenderState: (state, value) => (states.set(state, value), 0),
    getRenderState: (state) => ok(states.get(state) ?? 0),
    getTexture: () => ok(null),
    setTexture: () => 0,
    getTextureStageState: () => ok(0),
    setTextureStageState: () => 0,
    getSamplerState: () => ok(0),
    setSamplerState: () => 0,
    setScissorRect: () => 0,
    getScissorRect: () => ok({left: 0, top: 0, right: 1280, bottom: 720}),
    drawPrimitiveUP: (type, count, bytes, stride) => (
      draws.push({type, count, bytes: bytes.slice(), stride}),
      0
    ),
    setFVF: () => 0,
    getFVF: () => ok(0),
    createVertexShader: () => ok(object()),
    setVertexShader: () => 0,
    getVertexShader: () => ok(null),
    setVertexShaderConstantF: () => 0,
    getVertexShaderConstantF: (_r, n) => ok(new Float32Array(4 * n)),
    createPixelShader: () => ok(object()),
    setPixelShader: () => 0,
    getPixelShader: () => ok(null),
    setPixelShaderConstantF: () => 0,
  };
}

function load() {
  const loader = new NativeLibraryLoader([emoteDriverLibrary({shaders: null})], {
    locate: (name) => (name === 'emotedriver.dll' ? {kind: 'image', sha256: SHA256} : null),
  });
  const result = loader.load('emotedriver.dll');
  assert.equal(result.status, 'loaded');
  return {loader, driver: result.library.exports(EMOTE_DRIVER)};
}

test('emotedriver loads by hash and plays a motion file through the contract', () => {
  const {loader, driver} = load();
  const d3d = device();
  const emote = driver.emoteCreate({device: d3d});
  assert.equal(d3d.references, 2);
  const player = emote.createPlayer(motionFile());
  assert.ok(player);

  assert.equal(player.countMainTimelines() + player.countDiffTimelines(), 1);
  assert.equal(player.getDiffTimelineLabelAt(0), 'idle');
  const labels = Array.from({length: player.countVariables()}, (_, i) =>
    player.getVariableLabelAt(i),
  );
  assert.ok(labels.includes('head_LR'));

  player.show();
  player.playTimeline('idle', 1);
  assert.equal(player.isTimelinePlaying('idle'), true);
  const values = [];
  for (let frame = 0; frame < 40; frame++) {
    player.progress(1);
    player.render();
    values.push(player.getVariable('head_LR'));
  }
  assert.ok(values.every(Number.isFinite));
  assert.ok(new Set(values).size > 1, 'the timeline moves head_LR');
  assert.ok(d3d.draws.length > 0);
  for (const draw of d3d.draws) {
    assert.equal(draw.stride, 24);
    const floats = new Float32Array(draw.bytes.buffer, 0, draw.bytes.length / 4);
    assert.ok(floats.every(Number.isFinite));
  }

  const clone = player.clone();
  assert.equal(clone.getVariable('head_LR'), player.getVariable('head_LR'));
  clone.release();
  player.release();
  emote.release();
  assert.equal(d3d.references, 1);
  loader.dispose();
});

test('emoteFilterTexture hands RGBA8 levels to the filter and keeps its writes', () => {
  const {loader, driver} = load();
  const data = motionFile('RGBA8');
  const seen = [];
  driver.emoteFilterTexture(data, (pixels) => {
    seen.push(pixels.length);
    pixels.fill(0x7f);
  });
  assert.deepEqual(seen, [256 * 128 * 4, 128 * 64 * 4]);
  // The image stays decrypted: the filtered pixels are visible in place.
  let count = 0;
  for (const byte of data) if (byte === 0x7f) count++;
  assert.ok(count >= 256 * 128 * 4 + 128 * 64 * 4);
  loader.dispose();
});
