import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EmoteDeviceCore,
  emotePixelShaderIndex,
} from '../dist/native/emotedriver/runtime/render/device-core.js';
import {
  EmoteMotionRenderer,
  emoteMultiplyColor,
} from '../dist/native/emotedriver/runtime/render/renderer.js';
import {loadEmoteTexture} from '../dist/native/emotedriver/runtime/render/texture.js';
import {
  d3dxMatrixLookAtLH,
  d3dxVec3Project,
} from '../dist/native/emotedriver/runtime/render/d3dx.js';
import {extractEmoteShaderBlobs} from '../dist/native/emotedriver/runtime/render/shaders.js';
import {PEmoteDevice} from '../dist/native/emotedriver/device.js';
import {decryptPsbBody} from '../dist/formats/kirikiri/psb-filter.js';
import {DXT5_EMOTEDRIVER, Dxt5Decoder} from '../dist/graphics/s3tc.js';
import {buildPsb, f32, resource} from './kirikiri-psb-fixtures.mjs';

// D3D9 constants used in expectations.
const RS = {
  ZENABLE: 7,
  ALPHATESTENABLE: 15,
  SRCBLEND: 19,
  DESTBLEND: 20,
  CULLMODE: 22,
  ZFUNC: 23,
  ALPHAREF: 24,
  ALPHAFUNC: 25,
  ALPHABLENDENABLE: 27,
  STENCILENABLE: 52,
  STENCILFAIL: 53,
  STENCILZFAIL: 54,
  STENCILPASS: 55,
  STENCILFUNC: 56,
  STENCILREF: 57,
  STENCILMASK: 58,
  WRAP0: 128,
  LIGHTING: 137,
  BLENDOP: 171,
  SCISSORTESTENABLE: 174,
  SEPARATEALPHABLENDENABLE: 206,
  SRCBLENDALPHA: 207,
  DESTBLENDALPHA: 208,
  BLENDOPALPHA: 209,
};
const DXT5 = 0x35545844;
const VIEWPORT = {x: 0, y: 0, width: 800, height: 600, minZ: 0, maxZ: 1};
const IDENTITY = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1);

/** Synthetic shader blobs: one distinct byte each, so the log names which blob was used. */
function syntheticBlobs() {
  const names = new Map();
  const make = (prefix, count) =>
    Array.from({length: count}, (_, i) => {
      const blob = Uint8Array.of(i, prefix.length);
      names.set(blob, `${prefix}#${i}`);
      return blob;
    });
  return {
    blobs: {
      vertexSm2: make('vs2', 3),
      pixelSm2: make('ps2', 27),
      vertexSm3: make('vs3', 3),
      pixelSm3: make('ps3', 27),
    },
    names,
  };
}

/**
 * A recording `IDirect3DDevice9`: every contract call is appended to `log` as
 * `[member, ...arguments]` (objects by id), with plausible results.
 */
function recordingDevice({
  vs = 0xfffe0300,
  ps = 0xffff0300,
  formats = [DXT5],
  textureCaps = 0x4000,
  names = new Map(),
  renderStates = new Map(),
  cooperative = 0,
} = {}) {
  const log = [];
  const rec = (...entry) => log.push(entry);
  let textureCount = 0,
    shaderCount = 0;
  const surface = (tag, width, height) => ({
    tag,
    addRef: () => 1,
    release: () => (rec(`${tag}.release`), 0),
    getDesc: () => (rec(`${tag}.getDesc`), {format: 21, usage: 1, pool: 0, width, height}),
  });
  const texture = (width, height, levels, usage, format) => {
    const id = `tex${textureCount++}`;
    const t = {
      id,
      width,
      height,
      format,
      levels: [],
      addRef: () => 1,
      release: () => (rec(`${id}.release`), 0),
      getLevelDesc: () => ({hr: 0, value: null}),
      getSurfaceLevel: (level) => (
        rec(`${id}.getSurfaceLevel`, level),
        {hr: 0, value: surface(`${id}.surface`, width, height)}
      ),
      lockRect(level, rect, flags) {
        rec(`${id}.lockRect`, level, rect, flags);
        const w = Math.max(1, width >> level),
          h = Math.max(1, height >> level),
          blocks = format === DXT5,
          pitch = blocks ? Math.ceil(w / 4) * 16 : w * 4,
          bits = new Uint8Array(pitch * (blocks ? Math.ceil(h / 4) : h));
        t.levels[level] = bits;
        return {hr: 0, value: {pitch, bits}};
      },
      unlockRect: (level) => (rec(`${id}.unlockRect`, level), 0),
    };
    return t;
  };
  const shader = (kind, bytes) => {
    const id = names.get(bytes) ?? `${kind}${shaderCount++}`;
    return {id, addRef: () => 1, release: () => (rec(`${id}.release`), 0)};
  };
  const tag = (object) => (object === null ? null : (object.id ?? object.tag));
  const device = {
    log,
    textures: [],
    addRef: () => (rec('addRef'), 2),
    release: () => (rec('release'), 1),
    testCooperativeLevel: () => (rec('testCooperativeLevel'), cooperative),
    getDirect3D: () => (
      rec('getDirect3D'),
      {
        hr: 0,
        value: {
          addRef: () => 1,
          release: () => (rec('d3d.release'), 0),
          getAdapterDisplayMode: (adapter) => (
            rec('getAdapterDisplayMode', adapter),
            {hr: 0, value: {width: 800, height: 600, refreshRate: 60, format: 22}}
          ),
          checkDeviceFormat: (...args) => (
            rec('checkDeviceFormat', ...args),
            formats.includes(args[5]) ? 0 : -1
          ),
        },
      }
    ),
    getDeviceCaps: () => (
      rec('getDeviceCaps'),
      {
        hr: 0,
        value: {
          maxTextureWidth: 4096,
          maxTextureHeight: 4096,
          textureCaps,
          vertexShaderVersion: vs,
          pixelShaderVersion: ps,
        },
      }
    ),
    getDisplayMode: (chain) => (
      rec('getDisplayMode', chain),
      {hr: 0, value: {width: 800, height: 600, refreshRate: 60, format: 22}}
    ),
    createTexture(...args) {
      rec('createTexture', ...args);
      const t = texture(...args);
      device.textures.push(t);
      return {hr: 0, value: t};
    },
    setRenderTarget: (index, s) => (rec('setRenderTarget', index, tag(s)), 0),
    getRenderTarget: (index) => (
      rec('getRenderTarget', index),
      {hr: 0, value: surface('rt', 1024, 768)}
    ),
    clear: (rects, flags, color, z, stencil) => (rec('clear', rects, flags, color, z, stencil), 0),
    setTransform: () => 0,
    getTransform: (state) => (rec('getTransform', state), {hr: 0, value: IDENTITY}),
    setViewport: (v) => (rec('setViewport', {...v}), 0),
    getViewport: () => (rec('getViewport'), {hr: 0, value: VIEWPORT}),
    setRenderState: (state, value) => (
      rec('setRenderState', state, value),
      renderStates.set(state, value),
      0
    ),
    getRenderState: (state) => (
      rec('getRenderState', state),
      {hr: 0, value: renderStates.get(state) ?? 0}
    ),
    getTexture: () => ({hr: 0, value: null}),
    setTexture: (stage, t) => (rec('setTexture', stage, tag(t)), 0),
    getTextureStageState: (stage, type) => (
      rec('getTextureStageState', stage, type),
      {hr: 0, value: 0}
    ),
    setTextureStageState: (stage, type, value) => (
      rec('setTextureStageState', stage, type, value),
      0
    ),
    getSamplerState: (sampler, type) => (rec('getSamplerState', sampler, type), {hr: 0, value: 2}),
    setSamplerState: (sampler, type, value) => (rec('setSamplerState', sampler, type, value), 0),
    setScissorRect: (r) => (rec('setScissorRect', {...r}), 0),
    getScissorRect: () => (
      rec('getScissorRect'),
      {hr: 0, value: {left: 1, top: 2, right: 3, bottom: 4}}
    ),
    drawPrimitiveUP: (type, count, bytes, stride) => (
      rec('drawPrimitiveUP', type, count, bytes.slice(), stride),
      0
    ),
    setFVF: (fvf) => (rec('setFVF', fvf), 0),
    getFVF: () => (rec('getFVF'), {hr: 0, value: 0x44}),
    createVertexShader: (bytes) => (
      rec('createVertexShader', names.get(bytes) ?? bytes),
      {hr: 0, value: shader('vs', bytes)}
    ),
    setVertexShader: (s) => (rec('setVertexShader', tag(s)), 0),
    getVertexShader: () => (rec('getVertexShader'), {hr: 0, value: null}),
    setVertexShaderConstantF: (register, data, count) => (
      rec('setVertexShaderConstantF', register, Array.from(data.subarray(0, count * 4)), count),
      0
    ),
    getVertexShaderConstantF: (register, count) => (
      rec('getVertexShaderConstantF', register, count),
      {hr: 0, value: new Float32Array(count * 4)}
    ),
    createPixelShader: (bytes) => (
      rec('createPixelShader', names.get(bytes) ?? bytes),
      {hr: 0, value: shader('ps', bytes)}
    ),
    setPixelShader: (s) => (rec('setPixelShader', tag(s)), 0),
    getPixelShader: () => (rec('getPixelShader'), {hr: 0, value: null}),
    setPixelShaderConstantF: (register, data, count) => (
      rec('setPixelShaderConstantF', register, Array.from(data.subarray(0, count * 4)), count),
      0
    ),
  };
  return device;
}

/** A 2×2 RGBA8 texture record on `core` (texture index 0 of a renderer). */
function texturedRenderer(core) {
  const renderer = new EmoteMotionRenderer(core);
  const index = renderer.loadTexture(
    {
      type: 'RGBA8',
      width: 64,
      height: 32,
      truncatedWidth: null,
      truncatedHeight: null,
      pixel: {bytes: new Uint8Array(64 * 32 * 4)},
      mipMapLevel: null,
      mipMap: [],
    },
    'win',
  );
  assert.equal(index, 0);
  return renderer;
}

/** A synthetic drawable node (type 0) with a `columns`×`rows` grid at (x, y). */
function node(overrides = {}) {
  const columns = overrides.columns ?? 1,
    rows = overrides.rows ?? 1,
    x = overrides.x ?? 0,
    y = overrides.y ?? 0,
    positions = new Float32Array((columns + 1) * (rows + 1) * 2);
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i <= columns; i++) {
      positions[(j * (columns + 1) + i) * 2] = x + i * 10;
      positions[(j * (columns + 1) + i) * 2 + 1] = y + j * 10;
    }
  return {
    label: 'n',
    type: 0,
    parent: 0,
    inheritMask: 0,
    visible: true,
    drawable: true,
    x: 0,
    y: 0,
    z: 0,
    angle: 0,
    zoomX: 1,
    zoomY: 1,
    slantX: 0,
    slantY: 0,
    flipX: false,
    flipY: false,
    matrix: new Float32Array(4),
    velocityX: 0,
    velocityY: 0,
    opacity: 255,
    colors: Uint32Array.of(0x808080ff, 0x808080ff, 0x808080ff, 0x808080ff),
    blendMode: 0,
    source: 'a',
    icon: 'i',
    stencilType: 0,
    grid: {columns, rows, positions},
    child: null,
    textureIndex: 0,
    drawFlags: 0,
    sourceRect: [0, 0, 64, 32],
    ...overrides,
  };
}

const clipOf = (nodes, extra = {}) => ({
  nodeIndex: () => -1,
  nodes: [node({drawable: false}), ...nodes],
  ...extra,
});

/** Entries after frame begin (`LIGHTING` set) and before the restore (`setFVF(0x44)`). */
function drawPhase(log) {
  const start = log.findIndex((e) => e[0] === 'setRenderState' && e[1] === RS.LIGHTING);
  const end = log.findIndex((e, i) => i > start && e[0] === 'setFVF' && e[1] === 0x44);
  return log.slice(start + 1, end);
}

test('device init: caps, format checks, shader level and render-target probe', () => {
  const {blobs} = syntheticBlobs();
  const device = recordingDevice();
  const core = new EmoteDeviceCore(device, blobs);
  assert.deepEqual(device.log, [
    ['getDeviceCaps'],
    ['getDirect3D'],
    ['getAdapterDisplayMode', 0],
    ...[28, 50, 51, 25, 26, 23, 0x31545844, 0x33545844, DXT5].map((format) => [
      'checkDeviceFormat',
      0,
      1,
      22,
      0,
      3,
      format,
    ]),
    ['d3d.release'],
    ['createTexture', 256, 256, 1, 1, 23, 0],
    ['tex0.release'],
  ]);
  assert.equal(core.shaderLevel(), 2);
  assert.equal(core.formats.dxt5, true);
  assert.equal(core.formats.a8, false);
  assert.equal(new EmoteDeviceCore(recordingDevice({ps: 0xffff0200}), blobs).shaderLevel(), 1);
  assert.equal(new EmoteDeviceCore(recordingDevice({vs: 0xfffe0101}), blobs).shaderLevel(), 0);

  // Without the embedded blobs the device runs fixed-function and skips the probe.
  const plain = recordingDevice();
  const fixed = new EmoteDeviceCore(plain, null);
  assert.equal(fixed.shaderLevel(), 0);
  assert.equal(plain.log.filter((e) => e[0] === 'createTexture').length, 0);
});

test('IEmoteDevice options follow the core fields', () => {
  const {blobs} = syntheticBlobs();
  const device = recordingDevice();
  const emote = new PEmoteDevice({device}, () => null, blobs);
  assert.deepEqual(device.log.slice(0, 1), [['addRef']]);
  assert.equal(emote.getMaskMode(), 1); // ctor default
  assert.equal(emote.getAlphaMaskCapability(), 2);
  assert.equal(emote.getAlphaMaskEnabled(), 2);
  emote.setAlphaMaskEnabled(0);
  assert.equal(emote.getMaskMode(), 0); // clearing drops alpha masks
  emote.setMaskMode(1);
  assert.equal(emote.getMaskMode(), 0); // level 0 keeps stencil
  emote.setAlphaMaskEnabled(2);
  emote.setMaskMode(1);
  assert.equal(emote.getMaskMode(), 1);
  emote.setMaxTextureSize(8192, 1024);
  assert.equal(emote.core.maxTextureWidth, 4096);
  assert.equal(emote.core.maxTextureHeight, 1024);
  assert.equal(emote.getPixelateDivision(), 100);
  assert.equal(emote.getMipMapEnabled(), true);
  const source = {id: 'src', addRef: () => 1, release: () => 0};
  emote.setPixelateSource(source);
  assert.equal(emote.core.pixelateSource, source);
  emote.setPixelateSource(null);
  assert.equal(emote.core.pixelateSource, null);

  emote.core.pixelateSource = source;
  const before = device.log.length;
  emote.onDeviceLost();
  assert.equal(emote.core.lost, true);
  assert.equal(device.log.length, before); // nothing allocated yet
  assert.equal(emote.addRef(), 2);
  assert.equal(emote.release(), 1);
  assert.equal(emote.release(), 0);
  assert.deepEqual(device.log.at(-1), ['release']);
});

test('frame: state save, fixed state, restore in native order (level 0)', () => {
  const renderStates = new Map([[RS.ALPHAREF, 7]]);
  const device = recordingDevice({renderStates});
  const core = new EmoteDeviceCore(device, null);
  const renderer = new EmoteMotionRenderer(core);
  device.log.length = 0;
  renderer.renderClip(clipOf([]));
  const saved = [
    22, 24, 15, 25, 171, 19, 20, 27, 209, 207, 208, 137, 52, 53, 58, 7, 23, 56, 57, 55, 54, 174,
    128, 206,
  ];
  const stages = [
    [0, 4],
    [0, 5],
    [0, 6],
    [0, 1],
    [0, 2],
    [0, 3],
    [1, 1],
    [1, 2],
    [1, 3],
    [2, 1],
  ];
  const samplers = [
    [0, 1],
    [0, 2],
    [1, 1],
    [1, 2],
    [0, 5],
    [0, 6],
    [1, 5],
    [1, 6],
    [0, 7],
  ];
  const expected = [
    ['getTransform', 2],
    ['getTransform', 3],
    ['getTransform', 256],
    ['getViewport'],
    ['getFVF'],
    ['getScissorRect'],
    ...saved.map((s) => ['getRenderState', s]),
    ...stages.map(([st, ty]) => ['getTextureStageState', st, ty]),
    ...samplers.map(([s, ty]) => ['getSamplerState', s, ty]),
    ['getRenderTarget', 0],
    ['rt.getDesc'],
    ['rt.release'],
    ['setFVF', 0x142],
    ['setRenderState', RS.CULLMODE, 1],
    ['setRenderState', RS.ZENABLE, 0],
    ['setRenderState', RS.ALPHAREF, 0],
    ['setRenderState', RS.ALPHATESTENABLE, 1],
    ['setRenderState', RS.ALPHAFUNC, 5],
    ['setRenderState', RS.SEPARATEALPHABLENDENABLE, 1],
    ['setRenderState', RS.ALPHABLENDENABLE, 1],
    ['setRenderState', RS.BLENDOP, 1],
    ['setRenderState', RS.SRCBLEND, 5],
    ['setRenderState', RS.DESTBLEND, 6],
    ['setRenderState', RS.BLENDOPALPHA, 1],
    ['setRenderState', RS.DESTBLENDALPHA, 6],
    ['setRenderState', RS.SRCBLENDALPHA, 2],
    ['setTextureStageState', 0, 4, 4],
    ['setTextureStageState', 0, 5, 2],
    ['setTextureStageState', 0, 6, 0],
    ['setSamplerState', 0, 1, 3],
    ['setSamplerState', 0, 2, 3],
    ['setSamplerState', 1, 1, 3],
    ['setSamplerState', 1, 2, 3],
    ['setSamplerState', 0, 7, 2],
    ['setSamplerState', 0, 5, 2],
    ['setSamplerState', 0, 6, 2],
    ['setSamplerState', 1, 5, 2],
    ['setSamplerState', 1, 6, 2],
    ['setRenderState', RS.WRAP0, 0],
    ['setRenderState', RS.LIGHTING, 0],
    ['setFVF', 0x44],
    ['setScissorRect', {left: 1, top: 2, right: 3, bottom: 4}],
    ...saved.map((s) => ['setRenderState', s, s === RS.ALPHAREF ? 7 : 0]),
    ...stages.map(([st, ty]) => ['setTextureStageState', st, ty, 0]),
    ...samplers.map(([s, ty]) => ['setSamplerState', s, ty, 2]),
  ];
  assert.deepEqual(device.log, expected);

  // Point sampling without smoothing; alphaOp 1 keeps destination alpha.
  device.log.length = 0;
  renderer.smoothing = false;
  core.alphaOp = 1;
  renderer.renderClip(clipOf([]));
  const set = device.log.filter(
    (e) => e[0] === 'setSamplerState' && e[1] === 0 && (e[2] === 5 || e[2] === 6),
  );
  assert.deepEqual(set.slice(0, 2), [
    ['setSamplerState', 0, 5, 1],
    ['setSamplerState', 0, 6, 1],
  ]);
  assert.ok(
    device.log.some((e) => e[0] === 'setRenderState' && e[1] === RS.DESTBLENDALPHA && e[2] === 2),
  );
});

test('frame at shader level 2: cMat constant, VS 0, shader state saved and restored', () => {
  const {blobs, names} = syntheticBlobs();
  const device = recordingDevice({names});
  const core = new EmoteDeviceCore(device, blobs);
  const renderer = new EmoteMotionRenderer(core);
  device.log.length = 0;
  renderer.renderClip(clipOf([]));
  const shaderCalls = device.log.filter((e) => /Shader/.test(e[0]));
  assert.deepEqual(shaderCalls, [
    ['getVertexShaderConstantF', 0, 5],
    ['getVertexShader'],
    ['getPixelShader'],
    ['setVertexShaderConstantF', 0, Array.from(IDENTITY), 4],
    ['createVertexShader', 'vs3#0'],
    ['setVertexShader', 'vs3#0'],
    ['setVertexShaderConstantF', 0, new Array(20).fill(0), 5],
    ['setVertexShader', null],
    ['setPixelShader', null],
  ]);
});

test('blend table, alpha blending and the pixel shader index', () => {
  const blendRows = [
    [1, 6, 5],
    [1, 2, 5],
    [3, 2, 5],
    [1, 6, 9],
    [1, 2, 10],
    [3, 2, 5],
  ];
  const device = recordingDevice();
  const core = new EmoteDeviceCore(device, null);
  for (let mode = 0; mode < 6; mode++) {
    device.log.length = 0;
    core.setBlend(mode);
    const states = device.log.filter((e) => e[0] === 'setRenderState');
    const [op, dest, src] = blendRows[mode];
    assert.deepEqual(states.slice(0, 3), [
      ['setRenderState', RS.BLENDOP, op],
      ['setRenderState', RS.DESTBLEND, dest],
      ['setRenderState', RS.SRCBLEND, src],
    ]);
    assert.deepEqual(
      states.slice(3),
      mode === 0
        ? [
            ['setRenderState', RS.BLENDOPALPHA, 1],
            ['setRenderState', RS.DESTBLENDALPHA, 6],
            ['setRenderState', RS.SRCBLENDALPHA, 2],
          ]
        : [
            ['setRenderState', RS.BLENDOPALPHA, 1],
            ['setRenderState', RS.DESTBLENDALPHA, 2],
            ['setRenderState', RS.SRCBLENDALPHA, 1],
          ],
    );
  }
  // Fixed function: colour double, multiply (mode 3) and screen-like stage 1 (mode 5).
  device.log.length = 0;
  core.setBlend(0x13);
  assert.deepEqual(
    device.log.filter((e) => e[0] === 'setTextureStageState'),
    [
      ['setTextureStageState', 0, 2, 0],
      ['setTextureStageState', 0, 3, 2],
      ['setTextureStageState', 0, 1, 5],
      ['setTextureStageState', 1, 1, 4],
      ['setTextureStageState', 1, 2, 0x21],
      ['setTextureStageState', 1, 3, 1],
      ['setTextureStageState', 2, 1, 1],
    ],
  );
  device.log.length = 0;
  core.alphaOnly = true;
  core.setBlend(5);
  assert.deepEqual(
    device.log.filter((e) => e[0] === 'setTextureStageState'),
    [
      ['setTextureStageState', 0, 1, 2],
      ['setTextureStageState', 0, 2, 0],
      ['setTextureStageState', 1, 1, 2],
      ['setTextureStageState', 1, 2, 0x11],
      ['setTextureStageState', 2, 1, 1],
    ],
  );

  // Pixel shader index: variant + 3·mask + 6·colorDouble + 12·alphaOnly.
  assert.equal(emotePixelShaderIndex(0, false, false), 0);
  assert.equal(emotePixelShaderIndex(5, false, false), 1);
  assert.equal(emotePixelShaderIndex(3, true, false), 5);
  assert.equal(emotePixelShaderIndex(0x14, true, true), 23);
  assert.equal(emotePixelShaderIndex(0x12, false, true), 18);
  const {blobs, names} = syntheticBlobs();
  const shaded = recordingDevice({names, ps: 0xffff0200});
  const sm2 = new EmoteDeviceCore(shaded, blobs);
  sm2.maskBound = true;
  sm2.setBlend(0x14);
  assert.deepEqual(
    shaded.log.filter((e) => /PixelShader/.test(e[0])),
    [
      ['createPixelShader', 'ps2#11'],
      ['setPixelShader', 'ps2#11'],
    ],
  );
  assert.ok(!shaded.log.some((e) => e[0] === 'setTextureStageState'));
});

test('scissor: viewport-sized clip disables the test, others round half away from zero', () => {
  const device = recordingDevice();
  const core = new EmoteDeviceCore(device, null);
  core.viewport = VIEWPORT;
  device.log.length = 0;
  core.setClipRect(0, 0, 800, 600);
  core.setClipRect(-1.5, 2.5, 10.49, 20.5);
  assert.deepEqual(device.log, [
    ['setRenderState', RS.SCISSORTESTENABLE, 0],
    ['setRenderState', RS.SCISSORTESTENABLE, 1],
    ['setScissorRect', {left: -2, top: 3, right: 10, bottom: 21}],
  ]);
});

test('item draw: 24-byte vertices per grid row, bilinear corner colours, z/priority order', () => {
  const device = recordingDevice();
  const core = new EmoteDeviceCore(device, null);
  const renderer = texturedRenderer(core);
  device.log.length = 0;
  const a = node({
    columns: 2,
    rows: 1,
    z: 2,
    sourceRect: [16, 8, 32, 16],
    // Node corners: top-left, top-right, bottom-right, bottom-left (RGBA).
    colors: Uint32Array.of(0xff0000ff, 0x00ff00ff, 0x0000ffff, 0xffffffff),
  });
  const b = node({x: 100, z: 1, blendMode: 1});
  renderer.renderClip(clipOf([a, b]));
  const draws = drawPhase(device.log).filter((e) =>
    ['drawPrimitiveUP', 'setTexture', 'setRenderState'].includes(e[0]),
  );
  // b (z 1) draws before a (z 2); blend mode changes are set before each.
  assert.deepEqual(
    draws.map((e) =>
      e[0] === 'drawPrimitiveUP' ? ['drawPrimitiveUP', e[1], e[2], e[3].length, e[4]] : e,
    ),
    [
      // setBlend(0) at draw begin.
      ['setRenderState', RS.BLENDOP, 1],
      ['setRenderState', RS.DESTBLEND, 6],
      ['setRenderState', RS.SRCBLEND, 5],
      ['setRenderState', RS.BLENDOPALPHA, 1],
      ['setRenderState', RS.DESTBLENDALPHA, 6],
      ['setRenderState', RS.SRCBLENDALPHA, 2],
      ['setTexture', 0, 'tex0'],
      ['setRenderState', RS.BLENDOP, 1],
      ['setRenderState', RS.DESTBLEND, 2],
      ['setRenderState', RS.SRCBLEND, 5],
      ['setRenderState', RS.BLENDOPALPHA, 1],
      ['setRenderState', RS.DESTBLENDALPHA, 2],
      ['setRenderState', RS.SRCBLENDALPHA, 1],
      ['drawPrimitiveUP', 5, 2, 96, 24],
      ['setRenderState', RS.BLENDOP, 1],
      ['setRenderState', RS.DESTBLEND, 6],
      ['setRenderState', RS.SRCBLEND, 5],
      ['setRenderState', RS.BLENDOPALPHA, 1],
      ['setRenderState', RS.DESTBLENDALPHA, 6],
      ['setRenderState', RS.SRCBLENDALPHA, 2],
      ['drawPrimitiveUP', 5, 4, 144, 24],
      ['setRenderState', RS.SCISSORTESTENABLE, 0],
    ],
  );
  const bytes = draws.filter((e) => e[0] === 'drawPrimitiveUP')[1][3];
  const view = new DataView(bytes.buffer);
  const vertices = [];
  for (let at = 0; at < bytes.length; at += 24)
    vertices.push([
      view.getFloat32(at, true),
      view.getFloat32(at + 4, true),
      view.getFloat32(at + 8, true),
      view.getUint32(at + 12, true).toString(16),
      view.getFloat32(at + 16, true),
      view.getFloat32(at + 20, true),
    ]);
  // Colours: RGBA × neutral → ROR 8 → ARGB; the top row interpolates top-left → top-right
  // in 8.8 fixed point, the bottom row bottom-left (node corner 3) → bottom-right (corner 2).
  assert.deepEqual(vertices, [
    [0, 0, 0, 'ffff0000', 0.25, 0.25],
    [0, 10, 0, 'ffffffff', 0.25, 0.75],
    [10, 0, 0, 'ff7f7f00', 0.5, 0.25],
    [10, 10, 0, 'ff7f7fff', 0.5, 0.75],
    [20, 0, 0, 'ff00ff00', 0.75, 0.25],
    [20, 10, 0, 'ff0000ff', 0.75, 0.75],
  ]);
});

test('colour product, opacity and player colour on draw items', () => {
  assert.equal(emoteMultiplyColor(0x808080ff, 0x12345678), 0x12345678);
  assert.equal(emoteMultiplyColor(0xff4020ff, 0x80808080), 0xff402080);
  assert.equal(emoteMultiplyColor(0xffffffff, 0xffffffff), 0xffffffff); // clamped
  const device = recordingDevice();
  const core = new EmoteDeviceCore(device, null);
  const renderer = texturedRenderer(core);
  device.log.length = 0;
  renderer.renderClip(clipOf([node({opacity: 128})], {color: 0x808080ff}));
  const draw = device.log.find((e) => e[0] === 'drawPrimitiveUP');
  assert.equal(new DataView(draw[3].buffer).getUint32(12, true), 0x80808080);
});

test('protectTranslucentTextureColor draws a destination-alpha pass first', () => {
  const device = recordingDevice();
  const core = new EmoteDeviceCore(device, null);
  core.protectTranslucentTextureColor = true;
  const renderer = texturedRenderer(core);
  device.log.length = 0;
  renderer.renderClip(clipOf([node({opacity: 200}), node({x: 50, z: 1})]));
  const calls = drawPhase(device.log)
    .filter(
      (e) =>
        e[0] === 'drawPrimitiveUP' ||
        (e[0] === 'setRenderState' && [19, 20, 207, 208].includes(e[1])),
    )
    .map((e) => (e[0] === 'drawPrimitiveUP' ? 'draw' : `${e[1]}=${e[2]}`));
  assert.deepEqual(calls, [
    '20=6',
    '19=5',
    '208=6',
    '207=2',
    // Translucent item: protect pass, normal states, draw.
    '19=8',
    '20=7',
    '207=1',
    '208=2',
    'draw',
    '19=5',
    '20=6',
    '207=2',
    '208=6',
    'draw',
    // Opaque item: drawn once.
    'draw',
  ]);
});

test('stencil masks: include pass, reference counting and alpha-test edge', () => {
  const device = recordingDevice();
  const core = new EmoteDeviceCore(device, null);
  core.maskMode = 0;
  const renderer = texturedRenderer(core);
  const mask = node({stencilType: 1, z: 0});
  const exclude = node({stencilType: 2, z: 0, x: 5});
  const masked = node({z: 1, maskNode: mask});
  const mask2 = {...mask, maskNode: exclude};
  const masked2 = node({z: 2, maskNode: mask2});
  device.log.length = 0;
  renderer.renderClip(clipOf([mask, masked]));
  const stencilStates = new Set([7, 15, 23, 24, 25, 52, 53, 54, 55, 56, 57, 58]);
  const pick = (log) =>
    drawPhase(log)
      .filter(
        (e) =>
          e[0] === 'clear' ||
          e[0] === 'drawPrimitiveUP' ||
          (e[0] === 'setRenderState' && stencilStates.has(e[1])) ||
          e[0] === 'getRenderState',
      )
      .map((e) => (e[0] === 'drawPrimitiveUP' ? 'draw' : e.join(' ')));
  assert.deepEqual(pick(device.log), [
    'draw', // the mask layer itself, unmasked
    'clear  4 0 1 0',
    `setRenderState 52 1`,
    `setRenderState 53 1`,
    `setRenderState 58 255`,
    `setRenderState 7 1`,
    `setRenderState 23 1`,
    `getRenderState 15`,
    `getRenderState 25`,
    `getRenderState 24`,
    `setRenderState 15 1`,
    `setRenderState 25 5`,
    `setRenderState 24 64`,
    `setRenderState 56 3`,
    `setRenderState 57 0`,
    `setRenderState 55 7`,
    `setRenderState 54 7`,
    'draw', // mask into stencil
    `setRenderState 55 1`,
    `setRenderState 54 1`,
    `setRenderState 56 3`,
    `setRenderState 57 1`,
    `setRenderState 7 0`,
    `setRenderState 15 1`,
    `setRenderState 25 5`,
    `setRenderState 24 0`,
    'draw', // masked item
    `setRenderState 52 0`,
  ]);

  // Include + exclude: stencil cleared to 1, include ref 1, exclude ref 2, final ref 2.
  device.log.length = 0;
  renderer.renderClip(clipOf([exclude, mask2, masked2]));
  const refs = pick(device.log).filter((s) => /^clear|setRenderState (57|55) /.test(s));
  // The chain link (+0x68) is also an item's own mask: `mask2` is itself drawn masked by
  // `exclude` (exclude only: no include, exclude ref 1, final ref 1) before `masked2`.
  assert.deepEqual(refs, [
    'clear  4 0 1 1',
    'setRenderState 57 1',
    'setRenderState 55 8',
    'setRenderState 55 1',
    'setRenderState 57 1',
    'clear  4 0 1 1',
    'setRenderState 57 1',
    'setRenderState 55 7',
    'setRenderState 57 2',
    'setRenderState 55 8',
    'setRenderState 55 1',
    'setRenderState 57 2',
  ]);
});

test('alpha masks: ping-pong render targets, mask shaders and constants (SM3)', () => {
  const {blobs, names} = syntheticBlobs();
  const device = recordingDevice({names, textureCaps: 0});
  const core = new EmoteDeviceCore(device, blobs);
  assert.equal(core.maskMode, 1);
  const renderer = texturedRenderer(core);
  const first = node({stencilType: 1});
  const second = node({stencilType: 1, x: 3, maskNode: first});
  const masked = node({z: 1, maskNode: second});
  device.log.length = 0;
  // drawOrder walked backwards: the draw list is first, second, masked.
  renderer.renderClip(clipOf([first, second, masked], {drawOrder: [3, 2, 1]}));
  const interesting = new Set([
    'createTexture',
    'createVertexShader',
    'createPixelShader',
    'setRenderTarget',
    'getRenderTarget',
    'clear',
    'setTexture',
    'setViewport',
    'setVertexShader',
    'setPixelShader',
    'setPixelShaderConstantF',
    'setVertexShaderConstantF',
    'drawPrimitiveUP',
  ]);
  const calls = drawPhase(device.log)
    .filter((e) => interesting.has(e[0]) || /getSurfaceLevel|surface.release|rt.release/.test(e[0]))
    .map((e) => (e[0] === 'drawPrimitiveUP' ? 'draw' : JSON.stringify(e)));
  const vp = JSON.stringify(VIEWPORT);
  const scMul = `[${Math.fround(1 / 800)},${Math.fround(1 / 600)},0,0]`;
  assert.deepEqual(calls, [
    // frame begin at SM3: cMat, VS 0; draw begin: PS 0.
    `["setVertexShaderConstantF",0,${JSON.stringify(Array.from(IDENTITY))},4]`,
    '["createVertexShader","vs3#0"]',
    '["setVertexShader","vs3#0"]',
    '["createPixelShader","ps3#0"]',
    '["setPixelShader","ps3#0"]',
    // `first`: unmasked.
    '["setTexture",0,"tex1"]',
    'draw',
    // `second`, masked by `first`. Begin: two R5G6B5 targets of viewport size, target saved.
    '["createTexture",800,600,1,1,23,0]',
    '["createTexture",800,600,1,1,23,0]',
    '["getRenderTarget",0]',
    // first include mask: target A, VS 0, PS 24, cleared.
    '["setTexture",1,null]',
    '["tex2.getSurfaceLevel",0]',
    '["setRenderTarget",0,"tex2.surface"]',
    '["tex2.surface.release"]',
    `["setViewport",${vp}]`,
    '["createPixelShader","ps3#24"]',
    '["setPixelShader","ps3#24"]',
    '["clear",null,1,0,1,0]',
    'draw',
    // end: saved target back, VS 1, mask A on s1, masked PS 3 with cScMul.
    '["setRenderTarget",0,"rt"]',
    '["rt.release"]',
    `["setViewport",${vp}]`,
    '["createVertexShader","vs3#1"]',
    '["setVertexShader","vs3#1"]',
    '["setTexture",1,"tex2"]',
    '["createPixelShader","ps3#3"]',
    '["setPixelShader","ps3#3"]',
    `["setPixelShaderConstantF",0,${scMul},1]`,
    '["setTexture",0,"tex1"]',
    'draw',
    // `masked`, chain second → first: targets reused.
    '["getRenderTarget",0]',
    '["setTexture",1,null]',
    '["tex2.getSurfaceLevel",0]',
    '["setRenderTarget",0,"tex2.surface"]',
    '["tex2.surface.release"]',
    `["setViewport",${vp}]`,
    '["setVertexShader","vs3#0"]',
    '["setPixelShader","ps3#24"]',
    '["clear",null,1,0,1,0]',
    'draw',
    // second include: swap A/B, VS 1, PS 25 (cScMul), previous mask on s1 (intersection).
    '["setTexture",1,null]',
    '["tex3.getSurfaceLevel",0]',
    '["setRenderTarget",0,"tex3.surface"]',
    '["tex3.surface.release"]',
    `["setViewport",${vp}]`,
    '["setVertexShader","vs3#1"]',
    '["createPixelShader","ps3#25"]',
    '["setPixelShader","ps3#25"]',
    `["setPixelShaderConstantF",0,${scMul},1]`,
    '["clear",null,1,0,1,0]',
    '["setTexture",1,"tex2"]',
    'draw',
    '["setRenderTarget",0,"rt"]',
    '["rt.release"]',
    `["setViewport",${vp}]`,
    '["setTexture",1,"tex3"]',
    '["setPixelShader","ps3#3"]',
    `["setPixelShaderConstantF",0,${scMul},1]`,
    '["setTexture",0,"tex1"]',
    'draw',
    // end of list: unbind.
    '["setTexture",1,null]',
    '["setVertexShader","vs3#0"]',
    '["setPixelShader","ps3#0"]',
  ]);
});

test('mask region clipping scissors to the projected mask ∩ item bounds, ±2 px', () => {
  const device = recordingDevice();
  const core = new EmoteDeviceCore(device, null);
  core.maskMode = 0;
  core.maskRegionClipping = true;
  const renderer = texturedRenderer(core);
  const quad = (x0, y0, x1, y1) => ({
    columns: 1,
    rows: 1,
    positions: Float32Array.of(x0, y0, x1, y0, x0, y1, x1, y1),
  });
  const mask = node({stencilType: 1, grid: quad(0.1025, 0.2075, 0.6, 0.7)});
  const masked = node({z: 1, maskNode: mask, grid: quad(0.12, 0.25, 0.8, 0.9)});
  device.log.length = 0;
  renderer.renderClip(clipOf([mask, masked]));
  const scissors = drawPhase(device.log).filter((e) => e[0] === 'setScissorRect');
  // Identity transforms: x → 400 + 400·x, y → 300 − 300·y; mask ∩ item = (0.12, 0.25)–(0.6, 0.7).
  const project = (x, y) => d3dxVec3Project([x, y, 0], VIEWPORT, IDENTITY, IDENTITY, IDENTITY);
  const [ax, ay] = project(0.12, 0.25),
    [bx, by] = project(0.6, 0.7);
  const expected = {
    left: Math.floor(Math.min(ax, bx)) - 2,
    top: Math.floor(Math.min(ay, by)) - 2,
    right: Math.ceil(Math.max(ax, bx)) + 2,
    bottom: Math.ceil(Math.max(ay, by)) + 2,
  };
  assert.deepEqual(scissors[0], ['setScissorRect', expected]);
});

test('pixelate: reduced copy of the source texture, then mode-6 items with PS 26', () => {
  const {blobs, names} = syntheticBlobs();
  const device = recordingDevice({names, textureCaps: 0});
  const core = new EmoteDeviceCore(device, blobs);
  core.pixelateDivision = 80;
  const renderer = texturedRenderer(core);
  const source = {id: 'source', addRef: () => 1, release: () => 0};
  core.pixelateSource = source;
  device.log.length = 0;
  renderer.renderClip(clipOf([node({blendMode: 6})]));
  const phase = drawPhase(device.log);
  const calls = phase
    .filter((e) => !['setRenderState', 'setTextureStageState'].includes(e[0]))
    .map((e) => (e[0] === 'drawPrimitiveUP' ? ['drawPrimitiveUP', e[1], e[2], e[4]] : e));
  const height = Math.floor((600 * 80) / 800);
  const aspect = Math.fround(80 / height);
  const view = d3dxMatrixLookAtLH([-0.5, 0.5, -height / 2], [-0.5, 0.5, 0], [0, -1, 0]);
  view[0] = -view[0];
  const projection = Float32Array.of(
    Math.fround(1 / aspect),
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
    1,
    0,
    0,
    0,
    0,
  );
  const product = new Float32Array(16);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 4; j++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += view[i * 4 + k] * projection[k * 4 + j];
      product[j * 4 + i] = s; // transposed
    }
  const createIndex = calls.findIndex((e) => e[0] === 'createTexture' && e[5] === 21);
  assert.deepEqual(calls[createIndex], ['createTexture', 80, height, 1, 1, 21, 0]);
  const tail = calls.slice(createIndex + 1);
  assert.deepEqual(tail, [
    ['getRenderTarget', 0],
    ['tex2.getSurfaceLevel', 0],
    ['setRenderTarget', 0, 'tex2.surface'],
    ['tex2.surface.release'],
    ['setViewport', {x: 0, y: 0, width: 80, height, minZ: 0, maxZ: 1}],
    ['clear', null, 1, 0, 1, 0],
    ['setVertexShaderConstantF', 0, Array.from(product), 4],
    ['getSamplerState', 0, 5],
    ['setSamplerState', 0, 5, 1],
    ['setSamplerState', 0, 6, 1],
    ['setTexture', 0, 'source'],
    ['drawPrimitiveUP', 5, 2, 24],
    ['setTexture', 0, null],
    ['setRenderTarget', 0, 'rt'],
    ['rt.release'],
    ['setViewport', VIEWPORT],
    ['setVertexShaderConstantF', 0, Array.from(IDENTITY), 4],
    ['setSamplerState', 0, 5, 2],
    ['setSamplerState', 0, 6, 2],
    // mode-6 items: pixelate target on s1 (point), VS 2 + PS 26 with their constants.
    ['setTexture', 1, 'tex2'],
    ['setSamplerState', 1, 5, 1],
    ['setSamplerState', 1, 6, 1],
    ['createVertexShader', 'vs3#2'],
    ['setVertexShader', 'vs3#2'],
    ['createPixelShader', 'ps3#26'],
    ['setPixelShader', 'ps3#26'],
    ['setPixelShaderConstantF', 0, [Math.fround(1 / 800), Math.fround(1 / 600), 0, 0], 1],
    ['setTexture', 0, 'tex1'],
    ['drawPrimitiveUP', 5, 2, 24],
    ['setTexture', 1, null],
  ]);
  // Copy quad: (−w/2, −h/2)…(w/2, h/2), UV = viewport / render-target size (1024×768).
  const quad = phase.find((e) => e[0] === 'drawPrimitiveUP' && e[3].length === 96)[3];
  const dv = new DataView(quad.buffer);
  const v = (i, o) => dv.getFloat32(i * 24 + o, true);
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => [v(i, 0), v(i, 4), v(i, 16), v(i, 20)]),
    [
      [-40, -height / 2, 0, 0],
      [40, -height / 2, Math.fround(800 / 1024), 0],
      [-40, height / 2, 0, Math.fround(600 / 768)],
      [40, height / 2, Math.fround(800 / 1024), Math.fround(600 / 768)],
    ],
  );
  assert.equal(core.pixelateSource, null); // cleared after Render
});

test('texture upload: native DXT5 blocks, converted DXT5, RGBA8 byte order, mip levels', () => {
  const blocks = new Uint8Array(((8 * 8) / 16) * 16).map((_, i) => (i * 37) & 0xff);
  const texture = {
    type: 'DXT5',
    width: 8,
    height: 8,
    truncatedWidth: 4,
    truncatedHeight: 4,
    pixel: {bytes: blocks},
    mipMapLevel: 2,
    mipMap: [{width: 4, height: 4, pixel: {bytes: blocks.subarray(0, 16)}}],
  };
  const native = recordingDevice({formats: [DXT5]});
  const core = new EmoteDeviceCore(native, null);
  native.log.length = 0;
  const record = loadEmoteTexture(core, texture, 'win');
  assert.deepEqual(native.log.slice(0, 2), [
    ['createTexture', 4, 4, 2, 0, DXT5, 1],
    ['tex0.lockRect', 0, null, 0],
  ]);
  assert.equal(record.width, 4);
  // Truncated to 4×4: the first block of each 8-texel source block row (stride 8 bytes per
  // sub-row): bytes 0–3, 8–11, 16–19, 24–27.
  const level0 = native.textures[0].levels[0];
  assert.deepEqual(
    Array.from(level0),
    [0, 8, 16, 24].flatMap((o) => Array.from(blocks.subarray(o, o + 4))),
  );
  assert.deepEqual(Array.from(native.textures[0].levels[1]), Array.from(blocks.subarray(0, 16)));
  core.mipMapEnabled = false;
  loadEmoteTexture(core, texture, 'win');
  assert.equal(native.log.filter((e) => e[0] === 'createTexture').at(-1)[3], 1);

  // Without DXT5 support: CPU decode (emotedriver colour mode) to A8R8G8B8 (B, G, R, A).
  const converted = recordingDevice({formats: []});
  const soft = new EmoteDeviceCore(converted, null);
  loadEmoteTexture(
    soft,
    {...texture, truncatedWidth: null, truncatedHeight: null, mipMapLevel: null},
    'win',
  );
  const rgba = new Dxt5Decoder({wasm: false}).decode(blocks, 8, 8, DXT5_EMOTEDRIVER);
  const bgra = rgba.slice();
  for (let i = 0; i < bgra.length; i += 4) [bgra[i], bgra[i + 2]] = [rgba[i + 2], rgba[i]];
  assert.deepEqual(
    converted.log.find((e) => e[0] === 'createTexture'),
    ['createTexture', 8, 8, 1, 0, 21, 1],
  );
  assert.deepEqual(Array.from(converted.textures[0].levels[0]), Array.from(bgra));

  // RGBA8: stored B, G, R, A in `win` files (copied), R, G, B, A in `common` (swapped).
  const pixels = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8);
  const rgba8 = {
    ...texture,
    type: 'RGBA8',
    width: 2,
    height: 1,
    truncatedWidth: null,
    truncatedHeight: null,
    mipMapLevel: null,
    pixel: {bytes: pixels},
  };
  const plain = recordingDevice();
  const pcore = new EmoteDeviceCore(plain, null);
  loadEmoteTexture(pcore, rgba8, 'win');
  loadEmoteTexture(pcore, rgba8, 'common');
  assert.deepEqual(Array.from(plain.textures[0].levels[0]), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(Array.from(plain.textures[1].levels[0]), [3, 2, 1, 4, 7, 6, 5, 8]);
  assert.throws(() => loadEmoteTexture(pcore, {...rgba8, width: 8192}, 'win'), /not lifted/);
});

test('createPlayer decrypts each file, loads its sources and hands the model to the player core', () => {
  const psb = buildPsb({
    id: 'motion',
    spec: 'win',
    version: f32(3.03),
    screenSize: {width: 4, height: 4, originX: 0, originY: 0},
    source: {
      a: {
        texture: {type: 'RGBA8', width: 2, height: 2, pixel: resource(new Uint8Array(16))},
        icon: {},
      },
    },
    object: {},
    metadata: {
      base: {chara: 'c', motion: 'm'},
      mirror: 0,
      scale: 1,
      bustControl: [],
      hairControl: [],
      partsControl: [],
      eyeControl: [],
      eyebrowControl: [],
      mouthControl: [],
      transitionControl: [],
      clampControl: [],
      loopControl: [],
      mirrorControl: {variableMatchList: []},
      timelineControl: [],
    },
  });
  const encrypted = decryptPsbBody(psb, 742877301);
  const device = recordingDevice();
  const calls = [];
  const player = {};
  const emote = new PEmoteDevice(
    {device},
    (dev, model, flag, context) => (calls.push({dev, model, flag, context}), player),
    null,
  );
  const before = encrypted.slice();
  assert.equal(emote.createPlayer(encrypted), player);
  assert.deepEqual(encrypted, before); // caller's bytes untouched
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dev, emote);
  assert.equal(calls[0].flag, 1);
  assert.equal(calls[0].model.spec, 'win');
  assert.equal(calls[0].context.models.length, 1);
  assert.equal(calls[0].context.renderer.textureIndexOf('a'), 0);
  assert.ok(device.log.some((e) => e[0] === 'createTexture' && e[1] === 2 && e[5] === 21));
});

test('shader blob extraction verifies every SHA-256', () => {
  assert.equal(extractEmoteShaderBlobs(new Uint8Array(0x90000)), null);
});

test('shader blobs from the local emotedriver.dll match the documented hashes', async (t) => {
  const {readFile} = await import('node:fs/promises');
  let file;
  try {
    file = new Uint8Array(
      await readFile(new URL('../targetgame/nekopara_vol1/emotedriver.dll', import.meta.url)),
    );
  } catch {
    t.skip('game file not present');
    return;
  }
  const blobs = extractEmoteShaderBlobs(file);
  assert.ok(blobs !== null);
  assert.equal(blobs.pixelSm3.length, 27);
  assert.deepEqual(Array.from(blobs.vertexSm2[0].subarray(0, 4)), [0x00, 0x02, 0xfe, 0xff]);
  assert.deepEqual(Array.from(blobs.pixelSm3[26].subarray(0, 4)), [0x00, 0x03, 0xff, 0xff]);
});

test('IEmotePlayer::Render draws the current clip, clamped to the last one', () => {
  const device = recordingDevice();
  const core = new EmoteDeviceCore(device, null);
  const renderer = texturedRenderer(core);
  const clips = [clipOf([node()]), clipOf([node(), node({x: 30})])];
  device.log.length = 0;
  renderer.render({core: {clips, currentClip: 7}});
  assert.equal(device.log.filter((e) => e[0] === 'drawPrimitiveUP').length, 2);
  // Device lost: TestCooperativeLevel in Render and again in the frame; nothing drawn.
  const lost = recordingDevice({cooperative: 0x88760868 | 0});
  const lostCore = new EmoteDeviceCore(lost, null);
  lostCore.lost = true;
  lost.log.length = 0;
  new EmoteMotionRenderer(lostCore).render({core: {clips, currentClip: 0}});
  assert.deepEqual(lost.log, [['testCooperativeLevel'], ['testCooperativeLevel']]);
});
