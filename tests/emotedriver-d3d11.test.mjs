import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeLibraryLoader} from '../dist/platform/native-libraries.js';
import {EMOTE_DRIVER, EMOTE_DRIVER_D3D11} from '../dist/native/emotedriver/contract.js';
import {emoteDriverD3d11Library} from '../dist/native/emotedriver/library.js';
import {createEmoteMeshKernel} from '../dist/native/emotedriver/runtime/mesh/index.js';
import {EmoteModelCache, sameModelBytes} from '../dist/native/emotedriver/runtime/model-cache.js';
import {buildPsb, emoteWinTree, resource} from './kirikiri-psb-fixtures.mjs';

import {nativeHost, shaderStandins} from './emotedriver-d3d11-fixture.mjs';

const SHA = '80d28bd088dda8e97c7c47a9c664e55159f70505b0f9fde3158d8ce2a3e1e051';

/** A synthetic PSB with one image and a real scalar stereo parameter. */
function imageFile({variableFrame = -30, maskType = 0} = {}) {
  const tree = emoteWinTree(),
    motion = tree.object.all_parts.motion.base;
  const layer = structuredClone(motion.layer[0]);
  Object.assign(layer, {
    type: 0,
    objTriPriority: 0,
    stencilType: 0,
    label: 'image',
    children: [],
    frameList: [
      {time: 0, type: 3, content: {mask: 2, src: 'tex', icon: 'eye', coord: [0, 0, 0]}},
      {time: 61, type: 2, content: {mask: 2, src: 'tex', icon: 'eye', coord: [61, 0, 0]}},
    ],
  });
  motion.layer = [layer];
  motion.priority = [
    {time: 0, type: 1, content: [0]},
    {time: 61, type: 1, content: null},
  ];
  motion.layerIndexMap = {image: 0};
  if (maskType) {
    const mask = {
      ...structuredClone(layer),
      type: 12,
      label: 'mask',
      stencilType: maskType,
      stencilCompositeMaskLayerList: [],
      children: [layer],
    };
    motion.layer = [mask];
    motion.layerIndexMap = {mask: 0, image: 1};
    motion.priority = [
      {time: 0, type: 1, content: [0, 1]},
      {time: 61, type: 1, content: null},
    ];
  }
  Object.assign(tree.source.tex.texture, {
    type: 'RGBA8',
    width: 4,
    height: 4,
    pixel: resource(new Uint8Array(64).fill(255)),
  });
  delete tree.source.tex.texture.mipMap;
  delete tree.source.tex.texture.mipMapLevel;
  Object.assign(tree.source.tex.icon.eye, {
    left: 0,
    top: 0,
    width: 2,
    height: 2,
    originX: 0,
    originY: 0,
    resolution: 1,
  });
  tree.metadata = {
    format: 'emote',
    version: 1,
    base: {chara: 'all_parts', motion: 'base'},
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
    mirrorControl: {variableMatchList: []},
    timelineControl: [],
    stereovisionControl: {variableMatchList: ['head_LR']},
    variableList: [{label: 'head_LR', frameList: [{label: 'left', frame: variableFrame}]}],
  };
  return buildPsb(tree);
}

function load(wasm) {
  const kernel = createEmoteMeshKernel({driverSha256: SHA, wasm});
  assert.equal(kernel.accelerated, wasm);
  const loader = new NativeLibraryLoader(
    [emoteDriverD3d11Library({shaders: shaderStandins(), kernel})],
    {
      locate: (fileName) => ({kind: 'image', fileName, sha256: SHA}),
    },
  );
  const loaded = loader.load('emotedriver.dll');
  assert.equal(loaded.status, 'loaded');
  return {loader, library: loaded.library, exports: loaded.library.exports(EMOTE_DRIVER_D3D11)};
}

test('x64 parsed definitions reuse exact bytes while preserving file, motion and texture identities', () => {
  const cache = new EmoteModelCache(),
    bytes = imageFile({variableFrame: 14}),
    original = bytes.slice(),
    a = cache.read(bytes),
    b = cache.read(bytes.slice()),
    motion = (model) => model.objects.get('all_parts').motions.get('base'),
    texture = (model) => model.sources.get('tex').texture;
  assert.notEqual(a, b);
  assert.notEqual(motion(a), motion(b));
  assert.equal(motion(a).layers, motion(b).layers, 'Immutable definitions should be reused');
  assert.notEqual(texture(a), texture(b), 'Native GPU cache keys must remain per-resource');
  assert.notEqual(texture(a).pixel.bytes.buffer, bytes.buffer);
  const changed = imageFile({variableFrame: 15});
  assert.equal(changed.length, bytes.length);
  bytes.set(changed);
  const c = cache.read(bytes);
  assert.notEqual(motion(c).layers, motion(a).layers);
  assert.equal(c.metadata.variableList[0].frames[0].frame, 15);
  assert.equal(a.metadata.variableList[0].frames[0].frame, 14);
  bytes.fill(0);
  assert.throws(() => cache.read(bytes), /PSB/);
  assert.ok(texture(a).pixel.bytes.every((value) => value === 255));
  bytes.set(original);
  assert.equal(motion(cache.read(bytes)).layers, motion(a).layers);
  cache.clear();
  assert.notEqual(motion(cache.read(bytes)).layers, motion(a).layers);
  const buffer = Buffer.from(original),
    bufferCache = new EmoteModelCache(),
    owned = bufferCache.read(buffer);
  buffer.fill(0);
  assert.ok(texture(owned).pixel.bytes.every((value) => value === 255));
  assert.equal(motion(bufferCache.read(original)).layers, motion(owned).layers);
  const unaligned = new Uint8Array(new ArrayBuffer(original.length + 1), 1);
  unaligned.set(original);
  assert.equal(motion(bufferCache.read(unaligned)).layers, motion(owned).layers);
  const padded = new Uint8Array(original.length + 3);
  padded.set(original);
  const paddedModel = bufferCache.read(padded);
  padded[padded.length - 1] = 1;
  assert.notEqual(motion(bufferCache.read(padded)).layers, motion(paddedModel).layers);
});

test('x64 model cache byte equality detects every changed bit at aligned and unaligned offsets', () => {
  for (const length of [0, 1, 3, 4, 7, 31, 32, 33, 63, 64, 65, 97]) {
    const store = new Uint8Array(new ArrayBuffer(length + 8)),
      other = new Uint8Array(new ArrayBuffer(length + 8));
    for (const [left, right] of [
      [0, 0],
      [4, 0],
      [1, 0],
      [0, 3],
      [2, 2],
    ]) {
      const a = store.subarray(left, left + length),
        b = other.subarray(right, right + length);
      for (let i = 0; i < length; i++) a[i] = b[i] = (i * 37 + 11) & 255;
      assert.equal(sameModelBytes(a, b), true);
      for (let i = 0; i < length; i++)
        for (const bit of [1, 128]) {
          b[i] ^= bit;
          assert.equal(sameModelBytes(a, b), false, `length ${length} byte ${i} bit ${bit}`);
          b[i] ^= bit;
        }
      if (length) assert.equal(sameModelBytes(a, b.subarray(0, length - 1)), false);
    }
  }
});

test('x64 parsed model cache evicts by recency and source bytes without invalidating live definitions', () => {
  const bytes = [14, 15, 16].map((variableFrame) => imageFile({variableFrame})),
    layers = (model) => model.objects.get('all_parts').motions.get('base').layers,
    cache = new EmoteModelCache(2, bytes[0].length * 2),
    a = cache.read(bytes[0]),
    b = cache.read(bytes[1]);
  assert.equal(layers(cache.read(bytes[0])), layers(a));
  cache.read(bytes[2]);
  assert.equal(layers(cache.read(bytes[0])), layers(a));
  assert.notEqual(layers(cache.read(bytes[1])), layers(b));
  assert.equal(a.sources.get('tex').texture.pixel.bytes[0], 255);
  const sourceBound = new EmoteModelCache(4, bytes[0].length),
    first = sourceBound.read(bytes[0]);
  sourceBound.read(bytes[1]);
  assert.notEqual(layers(sourceBound.read(bytes[0])), layers(first));
  const uncached = new EmoteModelCache(4, bytes[0].length - 1);
  assert.notEqual(layers(uncached.read(bytes[0])), layers(uncached.read(bytes[0])));
});

test('x64 cached public creation preserves separate resources, variables and seeds on both kernels', () => {
  for (const wasm of [false, true]) {
    const host = nativeHost(),
      loaded = load(wasm),
      device = loaded.exports.emoteCreate(host),
      bytes = imageFile(),
      now = Date.now;
    let seeds = 0;
    Date.now = () => {
      seeds++;
      return 1700000000000;
    };
    try {
      const warm = device.createPlayer(bytes);
      warm.release();
      const a = device.createPlayer(bytes.slice()),
        b = device.createPlayers([bytes, bytes.slice()]),
        c = device.createPlayer(imageFile({variableFrame: 14}));
      assert.equal(seeds, 4);
      // The released warm atlas is reused by the next same-file player before any draw.
      assert.equal(host.created.filter((r) => r.kind === 'texture').length, 4);
      a.setVariable('head_LR', 4, 0, 0);
      b.setVariable('head_LR', 8, 0, 0);
      a.progress(1);
      b.progress(2);
      b.initCore();
      assert.equal(seeds, 4);
      assert.equal(a.getVariable('head_LR'), 4);
      assert.equal(b.getVariable('head_LR'), 0);
      assert.equal(c.getVariableFrameValueAt(0, 0), 14);
      a.release();
      b.release();
      c.release();
      device.release();
      assert.ok(host.created.slice(2).every((r) => r.references === 0));
    } finally {
      Date.now = now;
    }
    loaded.loader.dispose();
    host.context.release();
    host.device.release();
  }
});

test('x64 native exports retain independent player cores and shared clone resources on both kernels', () => {
  for (const wasm of [false, true]) {
    const host = nativeHost(),
      loaded = load(wasm);
    assert.equal(loaded.library.exports(EMOTE_DRIVER), null);
    assert.equal(loaded.exports.emoteGetSDKVersion(), '3.9.8');
    assert.equal(loaded.exports.emoteGetBuildDateTime(), '2022/12/28-13:02:35');
    const device = loaded.exports.emoteCreate(host);
    assert.equal(host.device.references, 2);
    assert.equal(host.context.references, 2);
    const bytes = imageFile(),
      before = bytes.slice(),
      player = device.createPlayer(bytes);
    assert.ok(player);
    assert.deepEqual(bytes, before);
    assert.equal(device.refCount(), 2);
    assert.equal(player.refCount(), 1);
    assert.equal(player.getSmoothing(), true);
    assert.equal(host.created.filter((r) => r.kind === 'texture').length, 1);
    player.setVariable('head_LR', 4, 0, 0);
    player.setCoord(12, -4, 0, 0);
    player.progress(0);
    const resources = host.created.length,
      clone = player.clone();
    assert.equal(host.created.length, resources);
    assert.equal(device.refCount(), 3);
    assert.equal(clone.getVariable('head_LR'), 4);
    assert.deepEqual(clone.getCoord(), {x: 12, y: -4});
    clone.setVariable('head_LR', 8, 0, 0);
    assert.equal(player.getVariable('head_LR'), 4);
    clone.setSmoothing(false);
    assert.equal(player.getSmoothing(), false);
    clone.startRecordAPILog();
    clone.setCoord(1, 2, 0, 0);
    assert.match(clone.getAPILog(), /^SetCoord 1\.000000 2\.000000 /);
    assert.equal(player.getAPILog(), '');
    clone.initCore();
    assert.equal(clone.getVariable('head_LR'), 0);
    assert.equal(clone.getAPILog(), '');
    assert.equal(clone.getSmoothing(), false);
    assert.equal(host.created.length, resources);
    clone.assignState(player);
    assert.equal(clone.getVariable('head_LR'), 4);
    assert.equal(player.addRef(), 2);
    assert.equal(player.release(), 1);
    assert.equal(device.release(), 2);
    assert.equal(player.release(), 0);
    clone.progress(1);
    assert.equal(clone.getVariable('head_LR'), 4);
    assert.equal(clone.release(), 0);
    assert.equal(device.refCount(), 0);
    assert.equal(host.device.references, 1);
    assert.equal(host.context.references, 1);
    assert.ok(host.created.slice(2).every((r) => r.references === 0));
    assert.throws(() => clone.progress(0), /released/);
    loaded.loader.dispose();
    host.context.release();
    host.device.release();
  }
});

test('x64 released atlases stay reusable until the next draw or texture miss', () => {
  const host = nativeHost(),
    loaded = load(false),
    device = loaded.exports.emoteCreate(host),
    atlases = () => host.created.filter((r) => r.kind === 'texture');
  const target = host.device.createTexture2D({width: 32, height: 24}, null).value,
    view = host.device.createRenderTargetView(target, null).value;
  device.setRenderTarget(view, null);
  const first = device.createPlayer(imageFile()),
    [atlas] = atlases().slice(-1);
  assert.equal(first.release(), 0);
  assert.ok(atlas.references > 0);
  const again = device.createPlayer(imageFile());
  assert.equal(atlases().at(-1), atlas);
  assert.equal(again.release(), 0);
  const other = device.createPlayer(imageFile({variableFrame: 14}));
  assert.equal(atlas.references, 0);
  const [otherAtlas] = atlases().slice(-1);
  assert.notEqual(otherAtlas, atlas);
  const idle = device.createPlayer(imageFile()),
    [idleAtlas] = atlases().slice(-1);
  assert.equal(idle.release(), 0);
  assert.ok(idleAtlas.references > 0);
  other.progress(0);
  other.render();
  assert.equal(idleAtlas.references, 0);
  assert.ok(otherAtlas.references > 0);
  assert.equal(other.release(), 0);
  assert.equal(device.release(), 0);
  host.context.clearState();
  view.release();
  target.release();
  assert.ok(host.created.slice(2).every((r) => r.references === 0));
  loaded.loader.dispose();
  host.context.release();
  host.device.release();
});

test('x64 public Render uses the selected evaluated clip and caller target without advancing clocks', () => {
  const host = nativeHost(),
    loaded = load(false),
    device = loaded.exports.emoteCreate(host);
  const player = device.createPlayer(imageFile());
  const texture = host.device.createTexture2D({width: 32, height: 24}, null).value;
  const view = host.device.createRenderTargetView(texture, null).value;
  device.setRenderTarget(view, null);
  assert.equal(host.calls.length, 0);
  assert.equal(view.references, 2);
  player.setStereovisionEnabled(true);
  player.progress(0);
  player.startRecordAPILog();
  player.setStereovisionRenderScreen(0);
  player.render();
  const first = host.calls.find((r) => r.method === 'vertices').bytes;
  assert.equal(host.calls.filter((r) => r.method === 'rsSetViewports').length, 0);
  host.calls.length = 0;
  player.setStereovisionRenderScreen(1);
  player.render();
  assert.notDeepEqual(host.calls.find((r) => r.method === 'vertices').bytes, first);
  assert.equal(player.getAPILog(), '');
  assert.equal(host.calls.filter((r) => r.method === 'draw').length, 1);
  const count = host.created.length;
  player.hide();
  player.progress(0);
  host.calls.length = 0;
  player.render();
  assert.equal(host.calls.filter((r) => r.method === 'draw').length, 0);
  assert.equal(host.created.length, count);
  player.release();
  device.release();
  host.context.clearState();
  view.release();
  texture.release();
  assert.ok(host.created.slice(2).every((r) => r.references === 0));
  loaded.loader.dispose();
  host.context.release();
  host.device.release();
});

test('x64 file groups use the last motion metadata and retain their resource clock across clone and InitCore', () => {
  const host = nativeHost(),
    loaded = load(false),
    device = loaded.exports.emoteCreate(host);
  const now = Date.now;
  let seeds = 0;
  Date.now = () => {
    seeds++;
    return 1700000000123;
  };
  try {
    const player = device.createPlayers([imageFile(), imageFile({variableFrame: 14})]);
    assert.equal(seeds, 1);
    assert.equal(player.getVariableFrameValueAt(0, 0), 14);
    const clone = player.clone();
    clone.initCore();
    assert.equal(seeds, 1);
    const other = device.createPlayer(imageFile());
    assert.equal(seeds, 2);
    assert.equal(other.getVariableFrameValueAt(0, 0), -30);
    assert.equal(host.created.filter((r) => r.kind === 'texture').length, 3);
    player.release();
    clone.release();
    other.release();
    device.release();
    assert.ok(host.created.slice(2).every((r) => r.references === 0));
  } finally {
    Date.now = now;
  }
  loaded.loader.dispose();
  host.context.release();
  host.device.release();
});

test('x64 public construction failures retire partially created native resources', () => {
  const loaded = load(false),
    host = nativeHost();
  host.fail('createPixelShader');
  assert.throws(() => loaded.exports.emoteCreate(host), /resource creation failed/);
  assert.equal(host.device.references, 1);
  assert.equal(host.context.references, 1);
  assert.ok(host.created.slice(2).every((r) => r.references === 0));
  host.fail(null);
  const device = loaded.exports.emoteCreate(host);
  const before = host.created.length;
  host.fail('texture');
  assert.throws(() => device.createPlayer(imageFile()), /texture creation failed/);
  assert.equal(device.refCount(), 1);
  assert.ok(host.created.slice(before).every((r) => r.references === 0));
  device.release();
  loaded.loader.dispose();
  host.context.release();
  host.device.release();
});

test('native mask-mode words are shared by live devices and reset with their DLL motion state', () => {
  const loaded = load(false),
    host = nativeHost();
  const a = loaded.exports.emoteCreate(host),
    b = loaded.exports.emoteCreate(host);
  assert.equal(a.getMaskMode(), 1);
  a.setMaskMode(0);
  assert.equal(b.getMaskMode(), 0);
  b.setMaskMode(0x100000001);
  assert.equal(a.getMaskMode(), 1);
  a.setMaskMode(0xffffffff);
  assert.equal(b.getMaskMode(), -1);
  const isolated = load(false),
    other = isolated.exports.emoteCreate(host);
  assert.equal(other.getMaskMode(), 1);
  other.release();
  isolated.loader.dispose();
  a.release();
  b.release();
  const fresh = loaded.exports.emoteCreate(host);
  assert.equal(fresh.getMaskMode(), 1);
  fresh.release();
  loaded.loader.dispose();
  host.context.release();
  host.device.release();
  assert.ok(host.created.slice(2).every((r) => r.references === 0));
});

test('public stencil masks clear and count through the native depth-stencil and alpha shaders', () => {
  for (const maskType of [1, 2]) {
    const host = nativeHost(),
      loaded = load(false),
      device = loaded.exports.emoteCreate(host);
    const player = device.createPlayer(imageFile({maskType}));
    const texture = host.device.createTexture2D({width: 4, height: 4, format: 28}, null).value;
    const view = host.device.createRenderTargetView(texture, null).value;
    const depth = host.device.createTexture2D({width: 4, height: 4, format: 45}, null).value;
    const dsv = host.device.createDepthStencilView(depth, {
      format: 45,
      viewDimension: 3,
      flags: 0,
      mipSlice: 0,
    }).value;
    device.setRenderTarget(view, dsv);
    device.setMaskMode(0);
    player.progress(0);
    player.render();
    assert.ok(
      host.calls.some(
        (c) =>
          c.method === 'clearDepthStencilView' &&
          c.args[1] === 2 &&
          c.args[3] === (maskType === 2 ? 1 : 0),
      ),
    );
    const states = host.calls.filter((c) => c.method === 'depthStencil');
    assert.ok(
      states.some(
        (c) =>
          c.desc?.stencilEnable &&
          c.desc.frontFace.stencilFunc === 3 &&
          c.desc.frontFace.stencilPassOp === (maskType === 1 ? 7 : 8) &&
          c.reference === (maskType === 2 ? 1 : 0),
      ),
    );
    assert.ok(
      states.some(
        (c) => c.desc?.stencilEnable && c.desc.frontFace.stencilPassOp === 1 && c.reference === 1,
      ),
    );
    assert.equal(states.at(-1).desc.stencilEnable, false);
    const draw = host.context.draw;
    host.context.draw = () => {
      throw new Error('synthetic stencil draw failure');
    };
    assert.throws(() => player.render(), /stencil draw failure/);
    assert.equal(
      host.calls.filter((c) => c.method === 'depthStencil').at(-1).desc.stencilEnable,
      false,
    );
    host.context.draw = draw;
    device.setMaskMode(99);
    assert.equal(device.getMaskMode(), 99);
    assert.throws(() => player.render(), /mask mode 99/);
    device.setMaskMode(0);
    player.render();
    player.release();
    device.release();
    host.context.clearState();
    dsv.release();
    depth.release();
    view.release();
    texture.release();
    assert.ok(host.created.slice(2).every((r) => r.references === 0));
    loaded.loader.dispose();
    host.context.release();
    host.device.release();
  }
});

test('x64 mask pool hands one released pair to the next renderer of the same output size', async () => {
  const {EmoteD3d11MaskPool} =
    await import('../dist/native/emotedriver/runtime/render/renderer-d3d11.js');
  const released = [],
    object = (name) => ({release: () => released.push(name)}),
    target = (name, width, height) => ({
      texture: object(name + '.texture'),
      view: object(name + '.view'),
      shaderView: object(name + '.srv'),
      width,
      height,
      subresource: 0,
      depth: null,
    }),
    pool = new EmoteD3d11MaskPool(),
    first = [target('a', 4, 3), target('b', 4, 3)];
  pool.keep(first);
  assert.equal(pool.take(4, 4), null);
  assert.equal(pool.take(4, 3), first);
  assert.equal(pool.take(4, 3), null);
  assert.deepEqual(released, []);
  pool.keep(first);
  pool.keep([target('c', 2, 2), target('d', 2, 2)]);
  assert.deepEqual(released, ['a.srv', 'a.view', 'a.texture', 'b.srv', 'b.view', 'b.texture']);
  pool.dispose();
  pool.dispose();
  assert.equal(released.length, 12);
});
