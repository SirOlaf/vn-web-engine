import test from 'node:test';
import assert from 'node:assert/strict';
import {D3d11ChildObject, D3d11Lifetime, D3d11Object} from '../dist/native/d3d11/runtime/com.js';
import {D3d11StateCache} from '../dist/native/d3d11/runtime/states.js';
import {D3d11ContextState} from '../dist/native/d3d11/runtime/context-state.js';
import {D3d11DrawContext} from '../dist/native/d3d11/webgl2/context.js';
import {createInputLayoutStorage} from '../dist/native/d3d11/runtime/input-layout.js';
import {readDxgiVertexElement} from '../dist/graphics/dxgi-vertex.js';
import {dxgiVertexByteAddress, fetchDxgiVertexElement} from '../dist/graphics/dxgi-vertex.js';
import {D3d11VertexReader, D3d11IndexReader} from '../dist/native/d3d11/runtime/input-assembly.js';
import {createShaderStorage} from '../dist/native/d3d11/runtime/shaders.js';
import {sm4SyntheticPipeline} from '../tools/lib/sm4-synthetic-fixtures.mjs';
import {
  createBufferStorage,
  createTexture2DStorage,
} from '../dist/native/d3d11/runtime/resources.js';
import {
  createShaderResourceViewStorage,
  createRenderTargetViewStorage,
  createDepthStencilViewStorage,
} from '../dist/native/d3d11/runtime/views.js';

const INVALID = 0x80070057 | 0;
function owner(disposeBindings = () => {}) {
  const lifetime = new D3d11Lifetime(disposeBindings),
    events = [];
  const device = new D3d11Object(lifetime, [], () => events.push('device'), true);
  return {lifetime, device, events};
}

test('D3D11 shader creation owns compiled interfaces through binding, getter and device reference lifetimes', () => {
  let context;
  const host = owner(() => context.disposeBindings());
  context = new D3d11ContextState(host);
  const fixture = sm4SyntheticPipeline();
  assert.deepEqual(createShaderStorage(host, 'vertex', fixture.vertex, null, true), {
    hr: 1,
    value: null,
  });
  const vertex = createShaderStorage(host, 'vertex', fixture.vertex, null).value;
  const pixel = createShaderStorage(host, 'pixel', fixture.pixel, null).value;
  assert.ok(vertex && pixel);
  const original = pixel.shader.code.source;
  fixture.pixel.fill(0);
  assert.equal(pixel.shader.code.source, original);
  assert.equal(vertex.queryInterface('ea82e40d-51dc-4f33-93d4-db7c9125ae8c').value, null);
  const alias = pixel.queryInterface('EA82E40D-51DC-4F33-93D4-DB7C9125AE8C').value;
  assert.equal(alias, pixel);
  alias.release();
  context.vsSetShader(vertex, []);
  context.psSetShader(pixel, []);
  vertex.release();
  pixel.release();
  const borrowed = context.psGetShader().shader;
  context.clearState();
  host.device.release();
  context.release();
  assert.equal(host.lifetime.closed, false);
  assert.equal(borrowed.getDevice(), host.device);
  host.device.release();
  borrowed.release();
  assert.equal(host.lifetime.closed, true);
  assert.equal(vertex.live, false);
  assert.equal(pixel.live, false);
});

test('D3D11 shader validation allocates no interface and refuses malformed or unsupported creation', () => {
  const host = owner(),
    fixture = sm4SyntheticPipeline();
  assert.equal(createShaderStorage(host, 'pixel', fixture.vertex, null).hr, INVALID);
  assert.equal(createShaderStorage(host, 'vertex', new Uint8Array(12), null).hr, INVALID);
  assert.equal(createShaderStorage(host, 'vertex', fixture.vertex, host.device).hr, 0x80004001 | 0);
  host.device.release();
  assert.equal(createShaderStorage(host, 'vertex', fixture.vertex, null, true).hr, INVALID);
});
const target = () => ({
  blendEnable: false,
  srcBlend: 0,
  destBlend: 0,
  blendOp: 0,
  srcBlendAlpha: 0,
  destBlendAlpha: 0,
  blendOpAlpha: 0,
  renderTargetWriteMask: 15,
});
const blend = () => ({
  alphaToCoverageEnable: false,
  independentBlendEnable: false,
  renderTarget: Array.from({length: 8}, target),
});
const face = () => ({stencilFailOp: 0, stencilDepthFailOp: 0, stencilPassOp: 0, stencilFunc: 0});
const depth = () => ({
  depthEnable: false,
  depthWriteMask: 0,
  depthFunc: 0,
  stencilEnable: false,
  stencilReadMask: 255,
  stencilWriteMask: 255,
  frontFace: face(),
  backFace: face(),
});
const raster = () => ({
  fillMode: 3,
  cullMode: 1,
  frontCounterClockwise: false,
  depthBias: 0,
  depthBiasClamp: 0,
  slopeScaledDepthBias: 0,
  depthClipEnable: true,
  scissorEnable: false,
  multisampleEnable: false,
  antialiasedLineEnable: false,
});
const sampler = () => ({
  filter: 0,
  addressU: 3,
  addressV: 3,
  addressW: 3,
  mipLodBias: 0,
  maxAnisotropy: 0,
  comparisonFunc: 0,
  borderColor: [0, 0, 0, 0],
  minLod: 0,
  maxLod: Math.fround(3.4028234663852886e38),
});

test('D3D11 state creation interns identical descriptors with independently owned references', () => {
  const host = owner(),
    cache = new D3d11StateCache(host),
    desc = blend();
  const a = cache.createBlendState(desc).value;
  desc.renderTarget[0].renderTargetWriteMask = 0;
  const b = cache.createBlendState(blend()).value;
  assert.equal(a, b);
  const copied = a.getDesc();
  copied.renderTarget[0].renderTargetWriteMask = 7;
  copied.renderTarget.pop();
  assert.equal(b.getDesc().renderTarget.length, 8);
  assert.equal(b.getDesc().renderTarget[0].renderTargetWriteMask, 15);
  assert.ok(Object.isFrozen(a.description.renderTarget[0]));
  assert.equal(a.release(), 1);
  assert.equal(b.release(), 0);
  const c = cache.createBlendState(blend()).value;
  assert.notEqual(c, a);
  c.release();
  host.device.release();
  assert.equal(host.lifetime.closed, true);
});

test('D3D11 state interfaces expose only their own IID and keep device access alive through children', () => {
  const host = owner(),
    cache = new D3d11StateCache(host);
  const state = cache.createDepthStencilState(depth()).value;
  const alias = state.queryInterface('03823EFB-8D8F-4E1C-9AA2-F64BB2CBFDF1');
  assert.equal(alias.value, state);
  alias.value.release();
  assert.equal(state.queryInterface('75b68faa-347d-4159-8f45-a0640f01cd9a').hr, 0x80004002 | 0);
  host.device.release();
  assert.equal(host.lifetime.closed, false);
  assert.equal(state.getDevice(), host.device);
  host.device.release();
  state.release();
  assert.equal(host.lifetime.closed, true);
  assert.deepEqual(host.events, ['device']);
});

test('D3D11 state descriptors retain native float32 values and owned nested arrays', () => {
  const host = owner(),
    cache = new D3d11StateCache(host);
  const desc = sampler();
  desc.minLod = 1 + 2 ** -30;
  desc.mipLodBias = -0;
  const a = cache.createSamplerState(desc).value;
  const b = cache.createSamplerState({...desc, minLod: 1}).value;
  assert.equal(a, b);
  assert.equal(a.getDesc().minLod, 1);
  assert.ok(Object.is(a.getDesc().mipLodBias, -0));
  desc.borderColor[0] = 1;
  const output = a.getDesc();
  output.borderColor[1] = 1;
  assert.deepEqual(a.getDesc().borderColor, [0, 0, 0, 0]);
  const r = cache.createRasterizerState({...raster(), depthBiasClamp: 1 + 2 ** -30}).value;
  assert.equal(r.getDesc().depthBiasClamp, 1);
  a.release();
  b.release();
  r.release();
  host.device.release();
});

test('D3D11 state validation respects inactive fields without accepting invalid active descriptions', () => {
  const host = owner(),
    cache = new D3d11StateCache(host);
  for (const [method, desc] of [
    ['createBlendState', blend()],
    ['createDepthStencilState', depth()],
    ['createRasterizerState', raster()],
    ['createSamplerState', sampler()],
  ]) {
    assert.deepEqual(cache[method](desc, true), {hr: 1, value: null});
    const state = cache[method](desc).value;
    assert.ok(state);
    state.release();
  }
  const badBlend = blend();
  badBlend.renderTarget[0].blendEnable = true;
  assert.equal(cache.createBlendState(badBlend).hr, INVALID);
  const badDepth = depth();
  badDepth.depthEnable = true;
  assert.equal(cache.createDepthStencilState(badDepth).hr, INVALID);
  const badStencil = depth();
  badStencil.stencilEnable = true;
  assert.equal(cache.createDepthStencilState(badStencil).hr, INVALID);
  assert.equal(cache.createSamplerState({...sampler(), filter: 128}).hr, INVALID);
  assert.equal(cache.createSamplerState({...sampler(), filter: 85}).hr, INVALID);
  assert.equal(cache.createSamplerState({...sampler(), maxLod: -1}).hr, INVALID);
  assert.equal(
    cache.createSamplerState({...sampler(), addressU: 4, borderColor: [2, 0, 0, 0]}).hr,
    INVALID,
  );
  assert.equal(cache.createRasterizerState({...raster(), depthBias: 0.5}).hr, INVALID);
  assert.equal(
    cache.createRasterizerState({...raster(), slopeScaledDepthBias: Infinity}).hr,
    INVALID,
  );
  const comparison = cache.createSamplerState({
    ...sampler(),
    filter: 213,
    maxAnisotropy: 16,
    comparisonFunc: 8,
  }).value;
  assert.ok(comparison);
  comparison.release();
  host.device.release();
  assert.equal(host.lifetime.closed, true);
});

test('D3D11 state caches enforce the native per-kind limit and reclaim retired entries', () => {
  const host = owner(),
    cache = new D3d11StateCache(host),
    states = [];
  for (let i = 0; i < 4096; i++)
    states.push(cache.createRasterizerState({...raster(), depthBias: i}).value);
  assert.ok(states.every(Boolean));
  assert.deepEqual(cache.createRasterizerState({...raster(), depthBias: 4096}), {
    hr: 0x887c0001 | 0,
    value: null,
  });
  const alias = cache.createRasterizerState({...raster(), depthBias: 0}).value;
  assert.equal(alias, states[0]);
  alias.release();
  assert.deepEqual(cache.createRasterizerState({...raster(), depthBias: 4096}, true), {
    hr: 1,
    value: null,
  });
  const otherKind = cache.createBlendState(blend()).value;
  assert.ok(otherKind);
  otherKind.release();
  states[0].release();
  const replacement = cache.createRasterizerState({...raster(), depthBias: 4096}).value;
  assert.ok(replacement);
  replacement.release();
  for (const state of states.slice(1)) state.release();
  host.device.release();
  assert.equal(host.lifetime.closed, true);
});

test('a pipeline-bound D3D11 state is not kept alive by its interning cache after final teardown', () => {
  let binding;
  const host = owner(() => binding.releaseBinding()),
    cache = new D3d11StateCache(host);
  binding = cache.createBlendState(blend()).value;
  binding.retainBinding();
  binding.release();
  assert.equal(binding.live, true);
  host.device.release();
  assert.equal(binding.live, false);
  assert.equal(cache.createBlendState(blend(), true).hr, INVALID);
});

function context() {
  let ctx;
  const host = owner(() => ctx.disposeBindings());
  host.destroyed = [];
  host.resourceDestroyed = (value) => host.destroyed.push(value);
  ctx = new D3d11ContextState(host);
  return {host, ctx, cache: new D3d11StateCache(host)};
}
const buffer = (host, bindFlags) =>
  createBufferStorage(
    host,
    {byteWidth: 32, usage: 0, bindFlags, cpuAccessFlags: 0, miscFlags: 0, structureByteStride: 0},
    null,
  ).value;
const texture = (host, changes = {}) =>
  createTexture2DStorage(
    host,
    {
      width: 8,
      height: 8,
      mipLevels: 0,
      arraySize: 1,
      format: 61,
      sampleDesc: {count: 1, quality: 0},
      usage: 0,
      bindFlags: 0x28,
      cpuAccessFlags: 0,
      miscFlags: 0,
      ...changes,
    },
    null,
  ).value;

test('D3D11 constant-buffer bindings preserve aliases, own getters and atomic rejection of foreign devices', () => {
  const {host, ctx} = context(),
    foreign = context();
  const a = buffer(host, 4),
    other = buffer(foreign.host, 4);
  ctx.vsSetConstantBuffers(0, [a, a]);
  a.release();
  ctx.vsSetConstantBuffers(0, [a, a]);
  assert.throws(() => ctx.vsSetConstantBuffers(0, [null, other]), /foreign/);
  const aliases = ctx.vsGetConstantBuffers(0, 2);
  assert.deepEqual(aliases, [a, a]);
  ctx.clearState();
  assert.deepEqual(host.destroyed, []);
  aliases.forEach((v) => v.release());
  assert.deepEqual(host.destroyed, [a]);
  assert.deepEqual(ctx.vsGetConstantBuffers(14, 0), []);
  assert.throws(() => ctx.psGetConstantBuffers(14, 1), /slots/);
  other.release();
  foreign.ctx.release();
  foreign.host.device.release();
  ctx.release();
  host.device.release();
  assert.equal(host.lifetime.closed, true);
});

test('D3D11 shader and input-layout bindings keep their own interface identities through clear-state', () => {
  const {host, ctx} = context(),
    retired = [];
  const vs = new D3d11ChildObject(host, ['3b301d64-d678-4289-8897-22f8928b72f3'], () =>
    retired.push('vs'),
  );
  const ps = new D3d11ChildObject(host, ['ea82e40d-51dc-4f33-93d4-db7c9125ae8c'], () =>
    retired.push('ps'),
  );
  const layout = new D3d11ChildObject(host, ['e4819ddc-4cf0-4025-bd26-5de82a3e07b7'], () =>
    retired.push('layout'),
  );
  ctx.vsSetShader(vs, []);
  ctx.psSetShader(ps, []);
  ctx.iaSetInputLayout(layout);
  assert.throws(() => ctx.vsSetShader(ps, []), /shader/);
  assert.throws(() => ctx.psSetShader(ps, [{}]), /class instances/);
  vs.release();
  ps.release();
  layout.release();
  const ownedVs = ctx.vsGetShader();
  assert.equal(ownedVs.shader, vs);
  assert.deepEqual(ownedVs.classInstances, []);
  const ownedLayout = ctx.iaGetInputLayout();
  assert.equal(ownedLayout, layout);
  ownedLayout.release();
  ctx.clearState();
  assert.deepEqual(retired, ['ps', 'layout']);
  ownedVs.shader.release();
  assert.deepEqual(retired, ['ps', 'layout', 'vs']);
  ctx.release();
  host.device.release();
});

test('D3D11 input assembler copies layouts and validates a whole binding update before replacing buffers', () => {
  const {host, ctx} = context();
  const vertices = buffer(host, 1),
    indices = buffer(host, 2),
    strides = [16, 0],
    offsets = [4, 8];
  ctx.iaSetVertexBuffers(2, [vertices, vertices], strides, offsets);
  ctx.iaSetIndexBuffer(indices, 57, 2);
  strides[0] = 8;
  offsets[0] = 12;
  vertices.release();
  indices.release();
  assert.throws(
    () => ctx.iaSetVertexBuffers(2, [null, indices], [16, 16], [0, 0]),
    /buffer binding/,
  );
  assert.throws(() => ctx.iaSetVertexBuffers(2, [null], [2049], [0]), /layout/);
  const state = ctx.iaGetVertexBuffers(2, 2);
  assert.deepEqual(state.strides, [16, 0]);
  assert.deepEqual(state.offsets, [4, 8]);
  state.strides[0] = 4;
  state.buffers.forEach((v) => v.release());
  const ib = ctx.iaGetIndexBuffer();
  assert.equal(ib.buffer, indices);
  assert.equal(ib.format, 57);
  assert.equal(ib.offset, 2);
  ib.buffer.release();
  ctx.iaSetPrimitiveTopology(5);
  assert.equal(ctx.iaGetPrimitiveTopology(), 5);
  ctx.clearState();
  assert.equal(ctx.iaGetPrimitiveTopology(), 0);
  assert.deepEqual(ctx.iaGetVertexBuffers(2, 2), {
    buffers: [null, null],
    strides: [0, 0],
    offsets: [0, 0],
  });
  assert.deepEqual(host.destroyed, [vertices, indices]);
  ctx.release();
  host.device.release();
});

test('D3D11 output binding clears only overlapping mip views and rejects duplicate or mismatched render targets atomically', () => {
  const {host, ctx} = context(),
    image = texture(host);
  const srv = (mip) =>
    createShaderResourceViewStorage(host, image, {
      format: 61,
      viewDimension: 4,
      texture2D: {mostDetailedMip: mip, mipLevels: 1},
    }).value;
  const rtv = (mip) =>
    createRenderTargetViewStorage(host, image, {
      format: 61,
      viewDimension: 4,
      texture2D: {mipSlice: mip},
    }).value;
  const a = srv(0),
    b = srv(1),
    out0 = rtv(0),
    out1 = rtv(1);
  const viewport = {topLeftX: 0, topLeftY: 0, width: 8, height: 8, minDepth: 0, maxDepth: 1};
  ctx.rsSetViewports([viewport]);
  ctx.psSetShaderResources(0, [a, b]);
  ctx.omSetRenderTargets([out0], null);
  let reads = ctx.psGetShaderResources(0, 2);
  assert.deepEqual(reads, [null, b]);
  reads[1].release();
  ctx.psSetShaderResources(0, [a]);
  assert.deepEqual(ctx.psGetShaderResources(0, 1), [null]);
  ctx.omSetRenderTargets([out1], null);
  assert.deepEqual(ctx.psGetShaderResources(0, 2), [null, null]);
  assert.throws(() => ctx.omSetRenderTargets([out0, out0], null), /Incompatible/);
  assert.throws(() => ctx.omSetRenderTargets([out0, out1], null), /Incompatible/);
  const outputs = ctx.omGetRenderTargets(2);
  assert.deepEqual(outputs.views, [out1, null]);
  outputs.views[0].release();
  assert.deepEqual(ctx.rsGetViewports(), [viewport]);
  ctx.omSetRenderTargets([], null);
  ctx.psSetShaderResources(0, [a, b]);
  const depthImage = texture(host, {mipLevels: 1, format: 45, bindFlags: 0x40});
  const depthView = createDepthStencilViewStorage(host, depthImage, null).value;
  ctx.omSetRenderTargets([out0], depthView);
  const depthAlias = ctx.omGetRenderTargets(0);
  assert.deepEqual(depthAlias.views, []);
  assert.equal(depthAlias.depthStencilView, depthView);
  depthAlias.depthStencilView.release();
  ctx.clearState();
  for (const v of [a, b, out0, out1, depthView, image, depthImage]) v.release();
  ctx.release();
  host.device.release();
  assert.equal(host.lifetime.closed, true);
});

test('D3D11 context state getters copy values, retain interfaces and restore every covered default on clear', () => {
  const {host, ctx, cache} = context();
  const blendState = cache.createBlendState(blend()).value,
    depthState = cache.createDepthStencilState(depth()).value;
  const rasterState = cache.createRasterizerState(raster()).value,
    samplerState = cache.createSamplerState(sampler()).value;
  const factor = [0.1, 0.2, 0.3, 0.4];
  ctx.omSetBlendState(blendState, factor, 0x55);
  ctx.omSetDepthStencilState(depthState, 0x1234);
  ctx.rsSetState(rasterState);
  ctx.psSetSamplers(3, [samplerState]);
  factor[0] = 1;
  ctx.rsSetScissorRects([{left: -2, top: 3, right: 7, bottom: 9}]);
  const rects = ctx.rsGetScissorRects();
  rects[0].right = 1;
  assert.equal(ctx.rsGetScissorRects()[0].right, 7);
  const b = ctx.omGetBlendState();
  assert.deepEqual(b.blendFactor, [0.1, 0.2, 0.3, 0.4].map(Math.fround));
  b.state.release();
  const d = ctx.omGetDepthStencilState();
  assert.equal(d.stencilRef, 0x1234);
  d.state.release();
  const r = ctx.rsGetState();
  assert.equal(r, rasterState);
  r.release();
  const s = ctx.psGetSamplers(3, 1);
  assert.equal(s[0], samplerState);
  s[0].release();
  assert.throws(() => ctx.omSetBlendState(blendState, [NaN, 0, 0, 0], 0), /factors/);
  for (const state of [blendState, depthState, rasterState, samplerState]) state.release();
  ctx.clearState();
  assert.deepEqual(ctx.omGetBlendState(), {
    state: null,
    blendFactor: [1, 1, 1, 1],
    sampleMask: 0xffffffff,
  });
  assert.deepEqual(ctx.omGetDepthStencilState(), {state: null, stencilRef: 0});
  assert.equal(ctx.rsGetState(), null);
  assert.deepEqual(ctx.psGetSamplers(3, 1), [null]);
  assert.deepEqual(ctx.rsGetScissorRects(), []);
  assert.deepEqual(ctx.rsGetViewports(), []);
  assert.equal(ctx.getType(), 0);
  assert.equal(ctx.getContextFlags(), 0);
  ctx.release();
  host.device.release();
});

test('D3D11 context teardown releases all bound resources and resets state even if multiple host disposals throw', () => {
  const {host, ctx} = context();
  host.resourceDestroyed = (resource) => {
    host.destroyed.push(resource);
    throw new Error('host disposal');
  };
  const a = buffer(host, 4),
    b = buffer(host, 4);
  ctx.vsSetConstantBuffers(0, [a, b]);
  a.release();
  b.release();
  assert.throws(
    () => ctx.clearState(),
    (e) => e instanceof AggregateError && e.errors.length === 2,
  );
  assert.deepEqual(host.destroyed, [a, b]);
  assert.deepEqual(ctx.vsGetConstantBuffers(0, 2), [null, null]);
  ctx.release();
  host.device.release();
  assert.equal(host.lifetime.closed, true);
});

test('last device/context release retires bound buffers, views and states without an explicit clear', () => {
  const {host, ctx, cache} = context(),
    constants = buffer(host, 4),
    image = texture(host);
  const view = createShaderResourceViewStorage(host, image, null).value;
  const state = cache.createBlendState(blend()).value;
  ctx.vsSetConstantBuffers(0, [constants]);
  ctx.psSetConstantBuffers(0, [constants]);
  ctx.psSetShaderResources(0, [view]);
  ctx.omSetBlendState(state, null, 0xffffffff);
  constants.release();
  image.release();
  view.release();
  state.release();
  ctx.release();
  assert.deepEqual(host.destroyed, []);
  assert.equal(view.live, true);
  assert.equal(state.live, true);
  host.device.release();
  assert.equal(host.lifetime.closed, true);
  assert.deepEqual(host.destroyed, [constants, image]);
  assert.equal(view.live, false);
  assert.equal(state.live, false);
  assert.throws(() => ctx.psGetShaderResources(0, 1), /released/);
});

function inputSignature(parameters) {
  const names = parameters.map((p) => new TextEncoder().encode(p.name + '\0'));
  const bodyLength = 8 + parameters.length * 24 + names.reduce((n, b) => n + b.length, 0),
    bytes = new Uint8Array(44 + bodyLength),
    view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode('DXBC'));
  view.setUint16(20, 1, true);
  view.setUint32(24, bytes.length, true);
  view.setUint32(28, 1, true);
  view.setUint32(32, 36, true);
  bytes.set(new TextEncoder().encode('ISGN'), 36);
  view.setUint32(40, bodyLength, true);
  view.setUint32(44, parameters.length, true);
  view.setUint32(48, 8, true);
  let name = 8 + parameters.length * 24;
  parameters.forEach((p, i) => {
    const at = 52 + i * 24;
    view.setUint32(at, name, true);
    view.setUint32(at + 4, p.index ?? 0, true);
    view.setUint32(at + 8, p.system ?? 0, true);
    view.setUint32(at + 12, p.type ?? 3, true);
    view.setUint32(at + 16, p.register, true);
    view.setUint8(at + 20, p.mask ?? 15);
    view.setUint8(at + 21, p.mask ?? 15);
    bytes.set(names[i], 44 + name);
    name += names[i].length;
  });
  return bytes;
}
const element = (semanticName, format, inputSlot = 0, alignedByteOffset = 0xffffffff) => ({
  semanticName,
  semanticIndex: 0,
  format,
  inputSlot,
  alignedByteOffset,
  inputSlotClass: 0,
  instanceDataStepRate: 0,
});

test('D3D11 input layout creation resolves each stream independently and owns its signature metadata', () => {
  const {host, ctx} = context();
  const bytes = inputSignature([
    {name: 'POSITION', register: 0, mask: 3},
    {name: 'COLOR', register: 1},
    {name: 'TEXCOORD', register: 2, mask: 3},
  ]);
  const desc = [element('position', 16, 2), element('COLOR', 87, 0, 1), element('TEXCOORD', 16, 2)];
  const result = createInputLayoutStorage(host, desc, bytes);
  assert.equal(result.hr, 0);
  const layout = result.value;
  assert.deepEqual(
    layout.elements.map((e) => [e.inputSlot, e.offset, e.register]),
    [
      [2, 0, 0],
      [0, 1, 1],
      [2, 8, 2],
    ],
  );
  desc[0].semanticName = 'changed';
  bytes.fill(0);
  assert.equal(layout.signature[0].semanticName, 'POSITION');
  assert.equal(layout.elements[0].semanticName, 'position');
  assert.ok(Object.isFrozen(layout.elements[0]));
  ctx.iaSetInputLayout(layout);
  layout.release();
  const alias = ctx.iaGetInputLayout();
  ctx.clearState();
  assert.equal(alias.live, true);
  alias.release();
  assert.equal(layout.live, false);
  ctx.release();
  host.device.release();
});

test('D3D11 input layout validation rejects missing/duplicate semantics while validation-only creation owns no interface', () => {
  const {host, ctx} = context(),
    bytes = inputSignature([{name: 'POSITION', register: 0, mask: 3}]);
  assert.deepEqual(createInputLayoutStorage(host, [element('POSITION', 16)], bytes, true), {
    hr: 1,
    value: null,
  });
  assert.equal(createInputLayoutStorage(host, [element('COLOR', 87)], bytes).hr, INVALID);
  assert.equal(
    createInputLayoutStorage(host, [element('POSITION', 16), element('position', 16)], bytes).hr,
    INVALID,
  );
  assert.equal(createInputLayoutStorage(host, [element('POSITION', 16, 0, 1)], bytes).hr, INVALID);
  assert.equal(
    createInputLayoutStorage(host, [{...element('POSITION', 16), instanceDataStepRate: 1}], bytes)
      .hr,
    INVALID,
  );
  assert.equal(createInputLayoutStorage(host, [element('POSITION', 16, 32)], bytes).hr, INVALID);
  assert.equal(
    createInputLayoutStorage(host, [element('POSITION', 999)], bytes).hr,
    0x80004001 | 0,
  );
  assert.equal(
    createInputLayoutStorage(host, [element('POSITION', 16)], new Uint8Array()).hr,
    INVALID,
  );
  const extra = createInputLayoutStorage(
    host,
    [element('POSITION', 6), element('EXTRA', 87)],
    bytes,
  ).value;
  assert.deepEqual(
    extra.elements.map((e) => e.register),
    [0, null],
  );
  extra.release();
  ctx.release();
  host.device.release();
  assert.equal(host.lifetime.closed, true);
});

test('DXGI input fetch keeps packed color expansion and float components exact across unaligned backing views', () => {
  const backing = new Uint8Array(32),
    data = new DataView(backing.buffer, 3, 24),
    out = new Float32Array(12).fill(42);
  data.setFloat32(0, -0, true);
  data.setFloat32(4, 1.25, true);
  data.setFloat32(8, -32768.5, true);
  readDxgiVertexElement(16, data, 0, out, 0);
  assert.ok(Object.is(out[0], -0));
  assert.deepEqual([...out.subarray(1, 4)], [1.25, 0, 1]);
  readDxgiVertexElement(6, data, 0, out, 4);
  assert.deepEqual([...out.subarray(5, 8)], [1.25, -32768.5, 1]);
  for (let value = 0; value < 256; value++) {
    const color =
      ((value << 24) | ((255 - value) << 16) | ((value ^ 85) << 8) | (value ^ 170)) >>> 0;
    data.setUint32(13, color, true);
    readDxgiVertexElement(87, data, 13, out, 8);
    assert.deepEqual(
      [...out.subarray(8, 12)],
      [(color >>> 16) & 255, (color >>> 8) & 255, color & 255, color >>> 24].map((v) =>
        Math.fround(v / 255),
      ),
    );
  }
  assert.throws(() => readDxgiVertexElement(6, data, 20, out, 0), /range/);
  assert.throws(() => readDxgiVertexElement(87, data, 13, out, 10), /range/);
  assert.throws(() => readDxgiVertexElement(0, data, 0, out, 0), /Unsupported/);
});

test('DXGI IA addressing agrees with independent full-width integer arithmetic and preserves native OOB defaults', () => {
  let random = 0x12345678;
  const next = () => (random = (Math.imul(random, 1664525) + 1013904223) >>> 0);
  const cases = [
    [0, 0xffffffff, 0xffffffff, 0],
    [16, 16, 0xffffffff, 0],
    [16, 16, 0x10000000, 0],
  ];
  for (let i = 0; i < 10000; i++) cases.push([next(), next(), next(), next()]);
  for (const [offset, stride, vertex, element] of cases) {
    const expected = Number(
      (BigInt(offset) + BigInt(stride) * BigInt(vertex) + BigInt(element)) & 0xffffffffn,
    );
    assert.equal(dxgiVertexByteAddress(offset, stride, vertex, element), expected);
  }
  const bytes = new Uint8Array(new Float32Array([1, 2, 3, 4]).buffer),
    data = new DataView(bytes.buffer);
  const out = new Float32Array(4).fill(99);
  for (const [format, missingAlpha] of [
    [16, 1],
    [6, 1],
    [87, 0],
  ]) {
    fetchDxgiVertexElement(format, data, 0, 4, out, 0);
    assert.deepEqual([...out], [0, 0, 0, missingAlpha]);
    fetchDxgiVertexElement(format, data, 16, 0, out, 0);
    assert.deepEqual([...out], [0, 0, 0, missingAlpha]);
  }
  fetchDxgiVertexElement(6, data, 8, 0, out, 0); // A partly readable element is still out of bounds.
  assert.deepEqual([...out], [0, 0, 0, 1]);
  assert.throws(() => fetchDxgiVertexElement(16, data, 0, 0, out, 1), /destination/);
});

const stream = (host, bytes, flags = 1) =>
  createBufferStorage(
    host,
    {
      byteWidth: bytes.byteLength,
      usage: 0,
      bindFlags: flags,
      cpuAccessFlags: 0,
      miscFlags: 0,
      structureByteStride: 0,
    },
    {data: bytes, rowPitch: 0, slicePitch: 0},
  ).value;
test('D3D11 vertex reads combine multiple streams and requested register order with unsigned address wrapping', () => {
  const {host, ctx} = context();
  const signature = inputSignature([
    {name: 'POSITION', register: 0},
    {name: 'TEXCOORD', index: 0, register: 1, mask: 3},
    {name: 'TEXCOORD', index: 1, register: 2, mask: 3},
  ]);
  const layout = createInputLayoutStorage(
    host,
    [
      element('POSITION', 6),
      element('TEXCOORD', 16, 1, 0),
      {...element('TEXCOORD', 16, 1, 8), semanticIndex: 1},
    ],
    signature,
  ).value;
  const positions = stream(host, new Uint8Array(new Float32Array([-1, -2, -3, 1, 2, 3]).buffer));
  const coords = stream(host, new Uint8Array(new Float32Array([0.125, 0.25, 0.5, 0.75]).buffer));
  const reader = new D3d11VertexReader(
    host,
    layout,
    [2, 0, 1],
    [positions, coords],
    [12, 0],
    [12, 0],
  );
  const out = new Float32Array(14).fill(99);
  reader.read(0, out, 1);
  assert.deepEqual([...out], [99, 0.5, 0.75, 0, 1, 1, 2, 3, 1, 0.125, 0.25, 0, 1, 99]);
  reader.read(0x40000000, out, 1);
  assert.deepEqual([...out.subarray(1, 13)], [0.5, 0.75, 0, 1, 1, 2, 3, 1, 0.125, 0.25, 0, 1]);
  reader.read(0xffffffff, out, 1); // Wrapped address0 lies below the bound offset12.
  assert.deepEqual([...out.subarray(1, 13)], [0.5, 0.75, 0, 1, 0, 0, 0, 1, 0.125, 0.25, 0, 1]);
  assert.throws(() => reader.read(0, new Float32Array(7)), /read/);
  assert.throws(() => new D3d11VertexReader(host, layout, [0], [null], [12], [0]), /Unbound/);
  layout.release();
  positions.release();
  coords.release();
  ctx.release();
  host.device.release();
});

test('D3D11 non-instanced draws use the first instance element and layouts require consistent stream classes', () => {
  const {host, ctx} = context();
  const signature = inputSignature([
    {name: 'COLOR', register: 0},
    {name: 'OTHER', register: 1},
  ]);
  assert.equal(
    createInputLayoutStorage(
      host,
      [element('COLOR', 16), element('OTHER', 16)],
      inputSignature([
        {name: 'COLOR', register: 0, mask: 3},
        {name: 'OTHER', register: 0, mask: 12},
      ]),
    ).hr,
    0x80004001 | 0,
  );
  const instance = {...element('COLOR', 87, 0, 1), inputSlotClass: 1, instanceDataStepRate: 3};
  for (const other of [
    element('OTHER', 87, 0, 5),
    {...element('OTHER', 87, 0, 5), inputSlotClass: 1, instanceDataStepRate: 2},
  ])
    assert.equal(createInputLayoutStorage(host, [instance, other], signature).hr, INVALID);
  const layout = createInputLayoutStorage(
    host,
    [instance],
    inputSignature([{name: 'COLOR', register: 0}]),
  ).value;
  const data = stream(host, new Uint8Array([9, 1, 2, 3, 4, 8, 7, 6, 5]));
  const reader = new D3d11VertexReader(host, layout, [0], [data], [4], [0]),
    out = new Float32Array(4);
  reader.read(0xffffffff, out);
  assert.deepEqual(
    [...out],
    [3, 2, 1, 4].map((n) => Math.fround(n / 255)),
  );
  layout.release();
  data.release();
  ctx.release();
  host.device.release();
});

test('D3D11 index reads retain strip-cut words and handle offsets, wraparound and out-of-bounds zero', () => {
  const {host, ctx} = context();
  for (const [format, values] of [
    [57, new Uint16Array([123, 7, 0xffff, 9])],
    [42, new Uint32Array([123, 7, 0xffffffff, 9])],
  ]) {
    const width = values.BYTES_PER_ELEMENT,
      buffer = stream(host, new Uint8Array(values.buffer), 2);
    const reader = new D3d11IndexReader(host, buffer, format, width);
    assert.equal(reader.read(0), 7);
    assert.equal(reader.read(1), format === 57 ? 0xffff : 0xffffffff);
    assert.equal(reader.read(3), 0);
    assert.equal(reader.read(0xffffffff), 0);
    assert.equal(reader.read(format === 57 ? 0x80000000 : 0x40000000), 7);
    buffer.release();
  }
  ctx.release();
  host.device.release();
});

test('D3D11 draw staging equals per-slot vertex reads and skips strip-cut slots', () => {
  const {host, ctx} = context();
  const signature = inputSignature([
    {name: 'POSITION', register: 0},
    {name: 'COLOR', register: 1},
  ]);
  const layout = createInputLayoutStorage(
    host,
    [element('POSITION', 6), element('COLOR', 87, 1, 0)],
    signature,
  ).value;
  const positions = stream(
    host,
    new Uint8Array(new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer),
  );
  const colors = stream(host, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
  const indices = stream(host, new Uint8Array(new Uint16Array([2, 0xffff, 0, 1, 7]).buffer), 2);
  const reader = new D3d11VertexReader(host, layout, [1, 0], [positions, colors], [12, 4], [0, 0]),
    index = new D3d11IndexReader(host, indices, 57, 0),
    slots = new Float64Array(5);
  for (const [start, base, cut, source] of [
    [0, 0, -1, null],
    [1, 0, -1, null],
    [0, 0, 0xffff, index],
    [0, -1, 0xffff, index],
    [0, 0, -1, index],
  ]) {
    const count = 5,
      expected = new Float32Array(count * 8).fill(99),
      actual = new Float32Array(count * 8 + 3).fill(99);
    for (let i = 0; i < count; i++) {
      const vertex = source ? source.read(start + i) : start + i;
      if (vertex !== cut) reader.read((vertex + base) >>> 0, expected, i * 4, count * 4);
    }
    reader.readDraw(actual, count, start, base, source, cut, slots);
    assert.deepEqual([...actual.subarray(0, count * 8)], [...expected]);
    assert.deepEqual([...actual.subarray(count * 8)], [99, 99, 99]);
  }
  assert.throws(() => reader.readDraw(new Float32Array(39), 5, 0, 0, null, -1, slots), /read/);
  assert.throws(
    () => reader.readDraw(new Float32Array(40), 5, 0, 0, null, -1, new Float64Array(4)),
    /read/,
  );
  for (const resource of [layout, positions, colors, indices, ctx]) resource.release();
  host.device.release();
});

test('native vertex registers can be staged in separate float4 planes without a256-byte stride', () => {
  const {host, ctx} = context(),
    parameters = Array.from({length: 16}, (_, i) => ({name: 'ATTR' + i, register: i, mask: 3}));
  const layout = createInputLayoutStorage(
    host,
    parameters.map((p) => element(p.name, 16)),
    inputSignature(parameters),
  ).value;
  const data = new Float32Array(64);
  for (let v = 0; v < 2; v++)
    for (let a = 0; a < 16; a++) {
      data[v * 32 + a * 2] = v * 100 + a;
      data[v * 32 + a * 2 + 1] = v * 100 + a + 0.5;
    }
  const source = stream(host, new Uint8Array(data.buffer)),
    reader = new D3d11VertexReader(
      host,
      layout,
      parameters.map((p) => p.register),
      [source],
      [128],
      [0],
    ),
    out = new Float32Array(128);
  reader.read(0, out, 0, 8);
  reader.read(1, out, 4, 8);
  assert.deepEqual(
    [...out],
    parameters.flatMap((_, a) => [a, a + 0.5, 0, 1, a + 100, a + 100.5, 0, 1]),
  );
  assert.throws(() => reader.read(0, out, 0, 3), /read/);
  assert.throws(() => reader.read(1, out, 5, 8), /read/);
  source.release();
  layout.release();
  ctx.release();
  host.device.release();
});

test('native Draw and DrawIndexed preserve planar inputs, base vertices, strip cuts and borrowed resource leases', () => {
  // This command sink proves CPU assembly and coordination only. It supplies no
  // GPU rendering evidence for the complete draw path.
  let ctx,
    uploaded,
    acquired = 0,
    released = 0,
    written = 0,
    visible = true,
    deleted = 0,
    gpuError = 0,
    errorQueries = 0;
  const calls = [],
    pointers = [];
  const host = owner(() => {
    ctx.disposeBindings();
    ctx.disposeGpu();
  });
  host.resourceDestroyed = () => {};
  const gl = {
    POINTS: 0,
    LINES: 1,
    LINE_STRIP: 3,
    TRIANGLES: 4,
    TRIANGLE_STRIP: 5,
    ARRAY_BUFFER: 0x8892,
    STREAM_DRAW: 0x88e0,
    FLOAT: 0x1406,
    TEXTURE0: 0x84c0,
    TEXTURE_2D: 0x0de1,
    NO_ERROR: 0,
    isContextLost: () => false,
    createVertexArray: () => ({}),
    createBuffer: () => ({}),
    bindVertexArray: () => {},
    bindBuffer: () => {},
    bufferData: (_target, data) => {
      uploaded = new Float32Array(data);
    },
    enableVertexAttribArray: () => {},
    disableVertexAttribArray: () => {},
    vertexAttribDivisor: () => {},
    vertexAttribPointer: (...args) => pointers.push(args),
    activeTexture: () => {},
    bindTexture: () => {},
    drawArrays: (...args) => calls.push(args),
    getError: () => {
      errorQueries++;
      const error = gpuError;
      gpuError = 0;
      return error;
    },
    flush: () => {},
    deleteVertexArray: () => {
      deleted++;
    },
    deleteBuffer: () => {
      deleted++;
    },
  };
  const program = {
    attributes: [
      {register: 0, location: 0},
      {register: 1, location: 1},
    ],
    registers: Object.freeze([0, 1]),
    samples: [],
  };
  ctx = new D3d11DrawContext(
    host,
    gl,
    {
      checkSubmission: () => false,
      acquireShaderResources: () => {
        acquired++;
        return {
          images: program.samples.map(() => ({})),
          release: () => {
            released++;
          },
        };
      },
    },
    {
      invalidateState: () => {},
      use: () => visible,
      unclippedDepth: () => false,
      normalizedTargetMask: 5,
      written: () => {
        written++;
      },
    },
    {
      use: () => program,
      uploadConstants: () => {},
      uploadOutputRanges: (selected, mask) => {
        assert.equal(selected, program);
        assert.equal(mask, 5);
      },
    },
    {
      bind: () => {
        throw Error('Unexpected sampler');
      },
    },
  );
  const fixture = sm4SyntheticPipeline(),
    vertex = createShaderStorage(host, 'vertex', fixture.vertex, null).value,
    pixel = createShaderStorage(host, 'pixel', fixture.pixel, null).value;
  const layout = createInputLayoutStorage(
    host,
    [element('POSITION', 6), element('COLOR', 87)],
    fixture.vertex,
  ).value;
  const bytes = new Uint8Array(64),
    data = new DataView(bytes.buffer);
  for (let i = 0; i < 4; i++) {
    data.setFloat32(i * 16, i + 1, true);
    data.setFloat32(i * 16 + 4, i * 2, true);
    data.setFloat32(i * 16 + 8, i * 0.25, true);
    data.setUint32(
      i * 16 + 12,
      (0x80000000 | ((i * 50) << 16) | ((i * 30) << 8) | (i * 10)) >>> 0,
      true,
    );
  }
  const source = stream(host, bytes);
  ctx.vsSetShader(vertex, []);
  ctx.psSetShader(pixel, []);
  ctx.iaSetInputLayout(layout);
  ctx.iaSetVertexBuffers(0, [source], [16], [0]);
  ctx.iaSetPrimitiveTopology(4);
  ctx.draw(3, 1);
  const expected = Float32Array.from(
    [1, 2, 3]
      .flatMap((i) => [i + 1, i * 2, i * 0.25, 1])
      .concat(
        [1, 2, 3].flatMap((i) => [(i * 50) / 255, (i * 30) / 255, (i * 10) / 255, 128 / 255]),
      ),
  );
  assert.deepEqual(new Uint32Array(uploaded.buffer), new Uint32Array(expected.buffer));
  assert.deepEqual(calls, [[4, 0, 3]]);
  assert.deepEqual(
    pointers.map((p) => [p[0], p[4], p[5]]),
    [
      [0, 0, 0],
      [1, 0, 48],
    ],
  );
  for (const [format, values] of [
    [57, new Uint16Array([99, 1, 2, 3, 0xffff, 2, 3, 4])],
    [42, new Uint32Array([99, 1, 2, 3, 0xffffffff, 2, 3, 4])],
  ]) {
    const indices = stream(host, new Uint8Array(values.buffer), 2);
    ctx.iaSetIndexBuffer(indices, format, 0);
    ctx.iaSetPrimitiveTopology(5);
    calls.length = 0;
    ctx.drawIndexed(7, 1, -1);
    assert.deepEqual(calls, [
      [5, 0, 3],
      [5, 4, 3],
    ]);
    for (const [ordinal, i] of [
      [0, 0],
      [1, 1],
      [2, 2],
      [4, 1],
      [5, 2],
      [6, 3],
    ]) {
      assert.deepEqual(
        [...uploaded.subarray(ordinal * 4, ordinal * 4 + 4)],
        [i + 1, i * 2, i * 0.25, 1],
      );
      assert.deepEqual(
        [...uploaded.subarray(28 + ordinal * 4, 32 + ordinal * 4)],
        [(i * 50) / 255, (i * 30) / 255, (i * 10) / 255, 128 / 255].map(Math.fround),
      );
    }
    ctx.iaSetPrimitiveTopology(4);
    calls.length = 0;
    ctx.drawIndexed(1, 4, 0);
    assert.deepEqual(calls, [[4, 0, 1]]);
    assert.deepEqual([...uploaded], [0, 0, 0, 1, 0, 0, 0, 0]); // An all-ones list index is an OOB vertex, not a strip cut.
    indices.release();
  }
  visible = false;
  const previous = calls.length;
  ctx.draw(3, 0);
  assert.equal(calls.length, previous);
  assert.equal(acquired, released);
  visible = true;
  program.samples = [{resource: 0, sampler: 0, unit: 0}];
  const beforeError = calls.length;
  assert.throws(() => ctx.draw(3, 0), /Unexpected sampler/);
  assert.equal(calls.length, beforeError);
  assert.equal(acquired, released);
  program.samples = [];
  assert.throws(
    () => ctx.draw(0xffffffff, 0),
    (error) => error.hr === (0x8007000e | 0),
  );
  ctx.iaSetIndexBuffer(null, 0, 0);
  ctx.drawIndexed(0, 0, 0);
  assert.throws(() => ctx.drawIndexed(1, 0, 0), /Unbound/);
  assert.equal(written, 5);
  assert.equal(acquired, released);
  assert.equal(errorQueries, 0, 'Adjacent draws must not synchronously query GPU errors');
  ctx.flush();
  assert.equal(errorQueries, 1);
  ctx.flush();
  assert.equal(errorQueries, 1, 'A checked batch needs no second error query');
  ctx.draw(3, 0);
  gpuError = 0x0502;
  assert.throws(() => ctx.flush(), /D3D11 draw failed: 1282/);
  assert.equal(errorQueries, 2, 'Submission errors must remain visible at flush');
  ctx.draw(3, 0);
  gpuError = 0x0505;
  ctx.publish();
  assert.equal(errorQueries, 2, 'Shared-image publication must not wait for GPU errors');
  assert.throws(() => ctx.flush(), /D3D11 draw failed: 1285/);
  assert.equal(errorQueries, 3, 'A published batch keeps its error for the next flush');
  assert.equal(acquired, released);
  source.release();
  layout.release();
  vertex.release();
  pixel.release();
  ctx.release();
  host.device.release();
  assert.equal(host.lifetime.closed, true);
  assert.equal(deleted, 2);
  ctx.disposeGpu();
  assert.equal(deleted, 2);
});
