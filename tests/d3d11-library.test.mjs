import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeLibraryLoader} from '../dist/platform/native-libraries.js';
import {D3D11, D3D11_SDK_VERSION} from '../dist/native/d3d11/contract.js';
import {d3d11WebGl2Library} from '../dist/native/d3d11/library.js';
import {EmoteD3d11Matrices} from '../dist/native/emotedriver/runtime/render/d3d11-matrices.js';
import {EmoteD3d11Screen} from '../dist/native/emotedriver/runtime/render/d3d11-screen.js';

test('native screen rectangles resolve at frame preparation and retain mode-1 manual state', () => {
  const screen = new EmoteD3d11Screen();
  const state = screen.prepare(320, 240, false);
  assert.deepEqual(Array.from(state), [...Array(14).fill(0), 0xffffffff]);
  screen.setScreenRect(10, 20, 100, 40, 0);
  assert.equal(screen.mode, -1);
  assert.deepEqual(
    Array.from(screen.prepare(320, 240, false)),
    [
      10, 180, 100, 40, 0x42480000, 0xc1a00000, 0x3f000000, 0, 0x42700000, 0x43480000, 0x3f000000,
      0, 0, 0x3f800000, 0,
    ],
  );
  screen.setScreenRect(99, 98, 1, 2, -1);
  const retained = state.slice();
  assert.equal(screen.prepare(640, 480, false), state);
  assert.deepEqual(state, retained);
  screen.prepare(640, 480, true);
  assert.equal(screen.mode, 1);
  assert.deepEqual(Array.from(state.subarray(0, 4)), [0, 0, 640, 480]);
  assert.deepEqual(
    Array.from(new Float32Array(state.buffer, 16, 10)),
    [320, 240, 0.5, 0, 320, 240, 0.5, 0, 0, 1],
  );
  screen.prepare(127, 67, true);
  assert.deepEqual(
    Array.from(new Float32Array(state.buffer, 16, 10)),
    [63.5, 33.5, 0.5, 0, 63.5, 33.5, 0.5, 0, 0, 1],
  );
});

test('native screen mapping keeps uint32 conversions, wraparound and signed zero', () => {
  const screen = new EmoteD3d11Screen();
  screen.setScreenRect(-1, 32, -1, 32, 0);
  const state = screen.prepare(16, 16, true);
  assert.deepEqual(Array.from(state.subarray(0, 4)), [0xffffffff, 0xffffffd0, 0xffffffff, 32]);
  assert.deepEqual(Array.from(new Float32Array(state.buffer, 16, 10)), [
    2 ** 31,
    -16,
    0.5,
    0,
    1.5 * 2 ** 32,
    2 ** 32,
    0.5,
    0,
    0,
    1,
  ]);
  screen.setScreenRect(0, 0, 0, 0, 0);
  screen.prepare(16, 16, false);
  assert.equal(state[5], 0x80000000);
  screen.setScreenRect(10.9, 20.1, 100.9, 40.9, 0x100000007);
  screen.prepare(320, 240, false);
  assert.equal(screen.mode, 7);
  assert.deepEqual(Array.from(state.subarray(0, 4)), [10, 20, 100, 40]);
  assert.deepEqual(
    Array.from(new Float32Array(state.buffer, 16, 10)),
    [50, 20, 0.5, 0, 60, 40, 0.5, 0, 0, 1],
  );
});

test('automatic camera uses target dimensions and the resolved screen orientation', () => {
  const screen = new EmoteD3d11Screen(),
    matrices = new EmoteD3d11Matrices();
  screen.setScreenRect(10, 20, 100, 40, 0);
  screen.prepare(320, 240, true);
  const upward = matrices.shaderMatrix(320, 240, screen.mode).slice();
  screen.setScreenRect(70, 80, 20, 10, 0);
  screen.prepare(320, 240, true);
  assert.deepEqual(matrices.shaderMatrix(320, 240, screen.mode), upward);
  screen.setScreenRect(70, 80, 20, 10, 7);
  screen.prepare(320, 240, true);
  const downward = matrices.shaderMatrix(320, 240, screen.mode).slice();
  assert.equal(downward[0], upward[0]);
  assert.equal(downward[5], -upward[5]);
  screen.setScreenRect(0, 0, 0, 0, -1);
  screen.prepare(320, 240, true);
  assert.deepEqual(matrices.shaderMatrix(320, 240, screen.mode), downward);
});

const INVALID = 0x80070057 | 0,
  UNSUPPORTED = 0x887a0004 | 0,
  REMOVED = 0x887a0005 | 0;
const bufferDesc = (extra = {}) => ({
  byteWidth: 16,
  usage: 0,
  bindFlags: 1,
  cpuAccessFlags: 0,
  miscFlags: 0,
  structureByteStride: 0,
  ...extra,
});
const textureDesc = (extra = {}) => ({
  width: 4,
  height: 4,
  mipLevels: 1,
  arraySize: 1,
  format: 65,
  sampleDesc: {count: 1, quality: 0},
  usage: 0,
  bindFlags: 0x28,
  cpuAccessFlags: 0,
  miscFlags: 0,
  ...extra,
});
function capabilityContext() {
  let lost = false;
  const deleted = [];
  const gl = {
    MAX_TEXTURE_SIZE: 0xd33,
    MAX_DRAW_BUFFERS: 0x8824,
    MAX_COLOR_ATTACHMENTS: 0x8cdf,
    MAX_VIEWPORT_DIMS: 0xd3a,
    MAX_TEXTURE_IMAGE_UNITS: 0x8872,
    CURRENT_PROGRAM: 0x8b8d,
    isContextLost: () => lost,
    getExtension: () => null,
    getParameter: (p) => {
      if (p === gl.MAX_TEXTURE_SIZE) return 16384;
      if (p === gl.MAX_DRAW_BUFFERS || p === gl.MAX_COLOR_ATTACHMENTS) return 8;
      if (p === gl.MAX_VIEWPORT_DIMS) return new Int32Array([16384, 16384]);
      if (p === gl.MAX_TEXTURE_IMAGE_UNITS) return 16;
      if (p === gl.CURRENT_PROGRAM) return null;
      throw Error('Unexpected capability ' + p);
    },
    deleteFramebuffer: (v) => deleted.push(['fbo', v]),
    deleteVertexArray: (v) => deleted.push(['vao', v]),
    deleteBuffer: (v) => deleted.push(['buffer', v]),
    deleteTexture: (v) => deleted.push(['texture', v]),
  };
  return {
    gl,
    deleted,
    lose: () => {
      lost = true;
    },
  };
}
function exportsFor(factory, options) {
  const loader = new NativeLibraryLoader([d3d11WebGl2Library(factory, options)], {
    locate: (fileName) => ({kind: 'system', fileName}),
  });
  const result = loader.load('D3D11.DLL');
  assert.equal(result.status, 'loaded');
  const exports = result.library.exports(D3D11);
  assert.ok(exports);
  return {loader, exports, handle: result.library};
}

test('UI backend registration receives borrowed native interfaces and unwinds failed registration', () => {
  const host = capabilityContext();
  let device, sharing;
  const loaded = exportsFor(() => host.gl, {
    deviceCreated: (value, service) => {
      device = value;
      sharing = service;
      throw new Error('synthetic registration refusal');
    },
  });
  const result = loaded.exports.d3d11CreateDevice(null, 1, 0, 0, null, 7);
  assert.notEqual(result.hr, 0);
  assert.equal(result.device, null);
  assert.equal(result.immediateContext, null);
  assert.equal(typeof sharing.acquireColorTexture, 'function');
  assert.throws(() => device.createBuffer(bufferDesc(), null), /retired/);
  loaded.loader.dispose();
});

test('D3D11 system exports validate SDK, driver, flags and ordered feature levels before host creation', () => {
  let calls = 0;
  const host = capabilityContext(),
    loaded = exportsFor(() => {
      calls++;
      return host.gl;
    });
  const create = (changes = {}) => {
    const p = {adapter: null, driver: 1, software: 0, flags: 0, levels: null, sdk: 7, ...changes};
    return loaded.exports.d3d11CreateDevice(
      p.adapter,
      p.driver,
      p.software,
      p.flags,
      p.levels,
      p.sdk,
    );
  };
  assert.equal(D3D11_SDK_VERSION, 7);
  for (const change of [
    {sdk: 6},
    {driver: 0},
    {software: 1},
    {levels: []},
    {levels: [0xbeef]},
    {levels: [0xb100]},
    {adapter: {}, driver: 1},
    {driver: 4, software: 0},
    {flags: NaN},
  ])
    assert.deepEqual(create(change), {
      hr: INVALID,
      device: null,
      featureLevel: 0,
      immediateContext: null,
    });
  assert.equal(create({flags: 2}).hr, 0x887a002d | 0);
  assert.equal(create({flags: 4}).hr, 0x80004001 | 0);
  assert.equal(create({levels: [0x9300]}).hr, UNSUPPORTED);
  assert.equal(calls, 0);
  const result = create({flags: 0x20, levels: [0xa000, 0xb000]});
  assert.equal(result.hr, 0);
  assert.equal(calls, 1);
  assert.equal(result.featureLevel, 0xa000);
  assert.equal(result.device.getFeatureLevel(), 0xa000);
  assert.equal(result.device.getCreationFlags(), 0x20);
  assert.equal(result.immediateContext.getType(), 0);
  assert.equal(result.immediateContext.getContextFlags(), 0);
  result.immediateContext.release();
  result.device.release();
  loaded.loader.free(loaded.handle);
  loaded.loader.dispose();
});

test('public D3D11 factories and immediate context preserve owned children after device/context caller release', () => {
  const host = capabilityContext(),
    loaded = exportsFor(() => host.gl),
    created = loaded.exports.d3d11CreateDevice(null, 1, 0, 0, null, 7),
    device = created.device,
    ctx = created.immediateContext;
  assert.equal(created.hr, 0);
  const alias = device.queryInterface('DB6F6DDB-AC77-4E88-8253-819DF9BBF140');
  assert.equal(alias.hr, 0);
  assert.equal(alias.value, device);
  alias.value.release();
  assert.deepEqual(device.createBuffer(bufferDesc(), null, true), {hr: 1, value: null});
  const initial = Uint8Array.from({length: 16}, (_, i) => i),
    source = device.createBuffer(bufferDesc(), {data: initial, rowPitch: 0, slicePitch: 0}).value,
    staging = device.createBuffer(
      bufferDesc({usage: 3, bindFlags: 0, cpuAccessFlags: 0x20000}),
      null,
    ).value;
  initial.fill(99);
  ctx.copyResource(staging, source);
  const mapped = ctx.map(staging, 0, 1, 0);
  assert.equal(mapped.hr, 0);
  assert.deepEqual(
    [...mapped.value.data],
    Array.from({length: 16}, (_, i) => i),
  );
  ctx.unmap(staging, 0);
  const tex = device.createTexture2D(textureDesc(), null).value,
    view = device.createRenderTargetView(tex, null).value;
  assert.ok(tex && view);
  tex.release();
  source.release();
  staging.release();
  assert.equal(device.checkFormatSupport(65).value, 0x2f320);
  assert.equal(device.checkFormatSupport(40).value, 0x11020);
  assert.deepEqual(device.checkFormatSupport(16), {hr: 0, value: 3});
  assert.deepEqual(device.checkFormatSupport(57), {hr: 0, value: 5});
  assert.deepEqual(device.checkFormatSupport(0), {hr: INVALID, value: null});
  device.release();
  ctx.release();
  const reacquired = view.getDevice(),
    resource = view.getResource(),
    context = reacquired.getImmediateContext();
  assert.equal(reacquired, device);
  assert.equal(resource, tex);
  assert.equal(context, ctx);
  assert.equal(context.getDevice(), device);
  device.release();
  resource.release();
  context.release();
  reacquired.release();
  view.release();
  assert.equal(device.queryInterface('db6f6ddb-ac77-4e88-8253-819df9bbf140').hr, 0x80004002 | 0);
  assert.ok(host.deleted.length > 0);
  assert.ok(host.deleted.every(([, object]) => object === null)); // No drawing or GPU allocations were faked.
  loaded.loader.free(loaded.handle);
  loaded.loader.dispose();
});

test('D3D11 creation and resource factories report unavailable or removed devices through HRESULTs', () => {
  for (const [factory, expected] of [
    [() => null, UNSUPPORTED],
    [
      () => {
        throw new RangeError('allocation');
      },
      0x8007000e | 0,
    ],
  ]) {
    const loaded = exportsFor(factory),
      r = loaded.exports.d3d11CreateDevice(null, 1, 0, 0, null, 7);
    assert.equal(r.hr, expected);
    assert.equal(r.device, null);
    loaded.loader.dispose();
  }
  const host = capabilityContext(),
    loaded = exportsFor(() => host.gl),
    r = loaded.exports.d3d11CreateDevice(null, 1, 0, 0, null, 7);
  host.lose();
  assert.equal(r.device.getDeviceRemovedReason(), REMOVED);
  assert.deepEqual(r.device.createBuffer(bufferDesc(), null), {hr: REMOVED, value: null});
  assert.deepEqual(r.device.createTexture2D(textureDesc(), null), {hr: REMOVED, value: null});
  assert.deepEqual(r.immediateContext.map({}, 0, 1, 0), {hr: INVALID, value: null});
  r.immediateContext.release();
  r.device.release();
  assert.equal(loaded.exports.d3d11CreateDevice(null, 1, 0, 0, null, 7).hr, REMOVED);
  loaded.loader.dispose();
});

test('E-mote native shader programs upload named constants through the public device and retain context-owned bindings', async () => {
  const {EmoteD3d11Program} =
    await import('../dist/native/emotedriver/runtime/render/d3d11-program.js');
  const {sm4SyntheticPipeline} = await import('../tools/lib/sm4-synthetic-fixtures.mjs');
  const host = capabilityContext(),
    loaded = exportsFor(() => host.gl);
  const created = loaded.exports.d3d11CreateDevice(null, 1, 0, 0, null, 7),
    device = created.device,
    ctx = created.immediateContext,
    shaders = sm4SyntheticPipeline(false, true);
  const reflection = (stage, size) => ({
    stage,
    flags: 0,
    creator: 'generated',
    resources: [],
    buffers: [
      {
        name: '$Globals',
        bytes: size,
        flags: 0,
        bufferType: 0,
        slot: 0,
        variables: [
          {
            name: 'value',
            offset: stage === 'vertex' ? 16 : 0,
            bytes: 16,
            flags: 2,
            type: {variableClass: 1, rows: 1, columns: 4},
            defaultValue: null,
          },
        ],
      },
    ],
  });
  const layout = [
    {
      semanticName: 'POSITION',
      semanticIndex: 0,
      format: 6,
      inputSlot: 0,
      alignedByteOffset: 0,
      inputSlotClass: 0,
      instanceDataStepRate: 0,
    },
    {
      semanticName: 'COLOR',
      semanticIndex: 0,
      format: 87,
      inputSlot: 0,
      alignedByteOffset: 12,
      inputSlotClass: 0,
      instanceDataStepRate: 0,
    },
  ];
  const vertex = new EmoteD3d11Program(device, shaders.vertex, reflection('vertex', 32), layout),
    pixel = new EmoteD3d11Program(device, shaders.pixel, reflection('pixel', 16), null);
  let uploads = 0,
    reject = true;
  const original = ctx.updateSubresource;
  ctx.updateSubresource = function (...args) {
    if (reject) throw Error('injected upload failure');
    uploads++;
    return original.apply(this, args);
  };
  assert.equal(vertex.setFloats('missing', [1]), false);
  assert.equal(vertex.setFloats('value', [1], 'missing-buffer'), false);
  assert.throws(() => vertex.setFloats('value', [1, 2, 3, 4, 5]), RangeError);
  vertex.setFloats('value', [-0, 1 / 3, 2, 3]);
  assert.throws(() => vertex.bind(ctx), /injected upload failure/);
  reject = false;
  vertex.bind(ctx);
  vertex.bind(ctx);
  assert.equal(uploads, 1); // Failed upload stayed dirty; an unchanged bind does not upload again.
  const raw = new Uint8Array(16),
    words = new DataView(raw.buffer);
  [0x7fc12345, 0x80000000, 0x00000001, 0xffffffff].forEach((v, i) =>
    words.setUint32(i * 4, v, true),
  );
  pixel.setRaw('value', raw);
  raw.fill(0);
  pixel.bind(ctx);
  pixel.bind(ctx);
  assert.equal(uploads, 2);
  const vsBuffer = ctx.vsGetConstantBuffers(0, 1)[0],
    psBuffer = ctx.psGetConstantBuffers(0, 1)[0],
    vs = ctx.vsGetShader().shader,
    ps = ctx.psGetShader().shader,
    input = ctx.iaGetInputLayout();
  const read = (buffer) => {
    const staging = device.createBuffer(
      bufferDesc({
        byteWidth: buffer.getDesc().byteWidth,
        usage: 3,
        bindFlags: 0,
        cpuAccessFlags: 0x20000,
      }),
      null,
    ).value;
    ctx.copyResource(staging, buffer);
    const mapped = ctx.map(staging, 0, 1, 0);
    assert.equal(mapped.hr, 0);
    const data = mapped.value.data.slice();
    ctx.unmap(staging, 0);
    staging.release();
    return new DataView(data.buffer);
  };
  const vb = read(vsBuffer),
    pb = read(psBuffer);
  assert.equal(vb.getUint32(16, true), 0x80000000);
  assert.equal(vb.getFloat32(20, true), Math.fround(1 / 3));
  assert.deepEqual(
    Array.from({length: 4}, (_, i) => vb.getFloat32(i * 4, true)),
    [0, 0, 0, 0],
  );
  assert.deepEqual(
    Array.from({length: 4}, (_, i) => pb.getUint32(i * 4, true)),
    [0x7fc12345, 0x80000000, 0x00000001, 0xffffffff],
  );
  vertex.dispose();
  pixel.dispose();
  vertex.dispose();
  assert.throws(() => vertex.bind(ctx), /released/);
  assert.throws(() => pixel.setRaw('value', raw), /released/);
  // The real Native context and getter references outlive the program owner's references.
  assert.equal(vs.getDevice(), device);
  device.release();
  assert.equal(vsBuffer.getDesc().byteWidth, 32);
  assert.ok(input && ps);
  ctx.vsSetShader(null, []);
  ctx.psSetShader(null, []);
  ctx.iaSetInputLayout(null);
  ctx.vsSetConstantBuffers(0, [null]);
  ctx.psSetConstantBuffers(0, [null]);
  for (const resource of [vs, ps, input, vsBuffer, psBuffer]) {
    resource.release();
    assert.equal(
      resource.queryInterface('00000000-0000-0000-c000-000000000046').hr,
      0x80004002 | 0,
    );
  }
  ctx.release();
  device.release();
  loaded.loader.dispose();
  assert.ok(host.deleted.every(([, object]) => object === null)); // No rendering or GPU allocation was faked.
});

test('E-mote shader construction releases partially created native resources when a later factory fails', async () => {
  const {EmoteD3d11Program} =
    await import('../dist/native/emotedriver/runtime/render/d3d11-program.js');
  const {sm4SyntheticPipeline} = await import('../tools/lib/sm4-synthetic-fixtures.mjs');
  const host = capabilityContext(),
    loaded = exportsFor(() => host.gl),
    created = loaded.exports.d3d11CreateDevice(null, 1, 0, 0, null, 7),
    device = created.device;
  const reflection = {
    stage: 'vertex',
    flags: 0,
    creator: 'generated',
    resources: [],
    buffers: [{name: '$Globals', bytes: 32, flags: 0, bufferType: 0, slot: 0, variables: []}],
  };
  let buffer, layout;
  const failing = {
    createBuffer: (...args) => {
      const r = device.createBuffer(...args);
      buffer = r.value;
      return r;
    },
    createInputLayout: (...args) => {
      const r = device.createInputLayout(...args);
      layout = r.value;
      return r;
    },
    createVertexShader: () => ({hr: INVALID, value: null}),
  };
  const elements = [
    {
      semanticName: 'POSITION',
      semanticIndex: 0,
      format: 6,
      inputSlot: 0,
      alignedByteOffset: 0,
      inputSlotClass: 0,
      instanceDataStepRate: 0,
    },
    {
      semanticName: 'COLOR',
      semanticIndex: 0,
      format: 87,
      inputSlot: 0,
      alignedByteOffset: 12,
      inputSlotClass: 0,
      instanceDataStepRate: 0,
    },
  ];
  assert.throws(
    () =>
      new EmoteD3d11Program(
        failing,
        sm4SyntheticPipeline(false, true).vertex,
        reflection,
        elements,
      ),
    /0x80070057/,
  );
  assert.ok(buffer && layout);
  for (const resource of [buffer, layout])
    assert.equal(
      resource.queryInterface('00000000-0000-0000-c000-000000000046').hr,
      0x80004002 | 0,
    );
  created.immediateContext.release();
  device.release();
  loaded.loader.dispose();
});

test('E-mote native shader bank selects disjoint native tables and unwinds every partially built program', async () => {
  const {
    EmoteD3d11Shaders,
    emoteD3d11BasicShader,
    emoteD3d11BufferedShader,
    emoteD3d11MaskShader,
    emoteD3d11AlphaShader,
  } = await import('../dist/native/emotedriver/runtime/render/d3d11-shaders.js');
  const slots = new Set([2040, 2041]);
  for (let k = 0; k < 5; k++) {
    for (const a of [0, 4, 8])
      for (let m = 0; m < 4; m++) {
        for (const f of [0, 3, 6, 9, 12])
          for (let b = 0; b < 3; b++) {
            const index = emoteD3d11BasicShader(k, a, m, f, b);
            assert.ok(!slots.has(index));
            slots.add(index);
          }
        for (let n = 0; n < 19; n++) {
          const index = emoteD3d11BufferedShader(k, a, m, n);
          assert.ok(!slots.has(index));
          slots.add(index);
        }
      }
    for (const alpha of [false, true])
      for (const pass of [0, 1, 2]) {
        const index = emoteD3d11MaskShader(k, alpha, pass);
        assert.ok(!slots.has(index));
        slots.add(index);
      }
    const index = emoteD3d11AlphaShader(k);
    assert.ok(!slots.has(index));
    slots.add(index);
  }
  assert.deepEqual(
    [...slots].sort((a, b) => a - b),
    Array.from({length: 2077}, (_, i) => i),
  );
  assert.equal(emoteD3d11BasicShader(1, 4, 0, 0, 0), 240);
  assert.equal(emoteD3d11BufferedShader(4, 8, 3, 18), 2039);
  assert.equal(emoteD3d11MaskShader(4, true, 2), 2071);
  for (const args of [
    [5, 0, 0, 0, 0],
    [0, 3, 0, 0, 0],
    [0, 0, 4, 0, 0],
    [0, 0, 0, 2, 0],
    [0, 0, 0, 0, 3],
  ])
    assert.throws(() => emoteD3d11BasicShader(...args), RangeError);
  const created = [];
  let failAt = Infinity;
  const make = () => {
    if (created.length === failAt) return {hr: INVALID, value: null};
    const resource = {
      references: 1,
      release() {
        return --this.references;
      },
    };
    created.push(resource);
    return {hr: 0, value: resource};
  };
  // Contract factory stand-in: only resource ownership is tested here, never GPU work.
  const initialized = [];
  const device = {
    createInputLayout: make,
    createVertexShader: (bytes) => {
      initialized.push(bytes[0]);
      return make();
    },
    createPixelShader: make,
  };
  const reflection = (stage) => ({
    stage,
    flags: 0,
    creator: 'generated',
    buffers: [],
    resources: [],
  });
  const blobs = {
    vertex: Array.from({length: 12}, (_, i) => Uint8Array.of(i)),
    pixel: Array(2077).fill(new Uint8Array()),
    vertexReflection: Array.from({length: 12}, () => reflection('vertex')),
    pixelReflection: Array.from({length: 2077}, () => reflection('pixel')),
    inputLayouts: Array.from({length: 12}, () => []),
  };
  const bank = new EmoteD3d11Shaders(device, blobs);
  assert.deepEqual(initialized, [3, 0, 4, 5, 1, 2, 9, 6, 10, 11, 7, 8]);
  assert.notEqual(bank.vertex(0), bank.vertex(11));
  assert.notEqual(bank.pixel(0), bank.pixel(2076));
  assert.throws(() => bank.pixel(2077), RangeError);
  bank.dispose();
  bank.dispose();
  assert.ok(created.every((r) => r.references === 0));
  assert.throws(() => bank.vertex(0), /released/);
  created.length = 0;
  failAt = 2100; // Failure at the last pixel factory after every earlier stage exists.
  assert.throws(() => new EmoteD3d11Shaders(device, blobs), /resource creation failed/);
  assert.equal(created.length, 2100);
  assert.ok(created.every((r) => r.references === 0));
});

test('E-mote packed meshes retain raw position bits and reject invalid or oversized grids before allocation', async () => {
  const {packEmoteD3d11Mesh, drawEmoteD3d11Mesh} =
    await import('../dist/native/emotedriver/runtime/render/d3d11-mesh.js');
  const storage = Uint32Array.of(
    0,
    0,
    0x80000000,
    0x7fa12345,
    0x3f800000,
    0,
    0x7fc54321,
    0xff800000,
    0xbf800000,
    0x3f000000,
    0,
    0,
  );
  const points = new Float32Array(storage.buffer, 8, 8),
    corners = Uint32Array.of(0x12345678, 0x9abcdef0, 0x11223344, 0x55667788),
    grid = {cols: 1, rows: 1, points},
    mesh = packEmoteD3d11Mesh(grid, corners, -2, 3, 5, 7, 8, 16),
    view = new DataView(mesh.vertices.buffer);
  assert.equal(mesh.vertexCount, 4);
  assert.equal(mesh.topology, 5);
  assert.equal(mesh.vertices.length, 80);
  for (const [i, p] of [0, 2, 1, 3].entries()) {
    assert.equal(view.getUint32(i * 20, true), storage[2 + p * 2]);
    assert.equal(view.getUint32(i * 20 + 4, true), storage[3 + p * 2]);
    assert.equal(view.getUint32(i * 20 + 8, true), corners[p]);
  }
  assert.deepEqual([...mesh.vertices.slice(8, 12)], [0x78, 0x56, 0x34, 0x12]);
  for (const bad of [
    {...grid, cols: -1},
    {...grid, rows: 0.5},
    {...grid, cols: NaN},
    {...grid, cols: Number.MAX_SAFE_INTEGER},
    {...grid, points: points.subarray(1)},
  ])
    assert.throws(() => packEmoteD3d11Mesh(bad, corners, 0, 0, 1, 1, 1, 1), RangeError);
  assert.throws(() => packEmoteD3d11Mesh(grid, corners.subarray(1), 0, 0, 1, 1, 1, 1), RangeError);
  // Valid-sized source storage; expanded output alone exceeds the renderer's bound.
  assert.throws(
    () =>
      packEmoteD3d11Mesh(
        {cols: 1024, rows: 1024, points: new Float32Array(1025 * 1025 * 2)},
        corners,
        0,
        0,
        1,
        1,
        1,
        1,
      ),
    /64 MiB/,
  );
  const empty = packEmoteD3d11Mesh(
    {cols: 0, rows: 1, points: new Float32Array(4)},
    corners,
    0,
    0,
    1,
    1,
    1,
    1,
  );
  assert.equal(empty.vertices.length, 0);
  assert.equal(empty.vertexCount, 0);
  drawEmoteD3d11Mesh({}, {}, empty); // Empty draws issue no contract calls.
});

test('E-mote mesh submission releases its buffer reference after a failed draw while context bindings remain owned', async () => {
  const {packEmoteD3d11Mesh, drawEmoteD3d11Mesh} =
    await import('../dist/native/emotedriver/runtime/render/d3d11-mesh.js');
  const host = capabilityContext(),
    loaded = exportsFor(() => host.gl),
    created = loaded.exports.d3d11CreateDevice(null, 1, 0, 0, null, 7),
    device = created.device,
    ctx = created.immediateContext,
    mesh = packEmoteD3d11Mesh(
      {cols: 1, rows: 1, points: Float32Array.of(0, 0, 2, 0, 0, 2, 2, 2)},
      Uint32Array.of(0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff),
      0,
      0,
      1,
      1,
      1,
      1,
    );
  // Actual public factories and bindings; drawing intentionally fails before GPU work.
  const interrupted = {
    iaSetVertexBuffers: (...args) => ctx.iaSetVertexBuffers(...args),
    iaSetPrimitiveTopology: (...args) => ctx.iaSetPrimitiveTopology(...args),
    draw: () => {
      throw Error('interrupted draw');
    },
  };
  assert.throws(() => drawEmoteD3d11Mesh(device, interrupted, mesh), /interrupted draw/);
  const bound = ctx.iaGetVertexBuffers(0, 1),
    buffer = bound.buffers[0];
  assert.deepEqual(bound.strides, [20]);
  assert.deepEqual(bound.offsets, [0]);
  assert.equal(buffer.getDesc().byteWidth, 80);
  assert.equal(buffer.getDesc().usage, 0);
  const staging = device.createBuffer(
    bufferDesc({byteWidth: 80, usage: 3, bindFlags: 0, cpuAccessFlags: 0x20000}),
    null,
  ).value;
  ctx.copyResource(staging, buffer);
  const mapped = ctx.map(staging, 0, 1, 0);
  assert.equal(mapped.hr, 0);
  assert.deepEqual(mapped.value.data, mesh.vertices);
  ctx.unmap(staging, 0);
  staging.release();
  assert.equal(buffer.release(), 1); // The context is the only remaining owner.
  ctx.iaSetVertexBuffers(0, [null], [0], [0]);
  assert.equal(buffer.queryInterface('00000000-0000-0000-c000-000000000046').hr, 0x80004002 | 0);
  host.lose();
  assert.throws(() => drawEmoteD3d11Mesh(device, ctx, mesh), /vertex buffer creation failed/);
  ctx.release();
  device.release();
  loaded.loader.dispose();
});

test('E-mote native atlas ownership preserves direct source bytes, DXGI formats and live context references', async () => {
  const {EmoteD3d11Textures} =
    await import('../dist/native/emotedriver/runtime/render/d3d11-textures.js');
  const host = capabilityContext(),
    loaded = exportsFor(() => host.gl),
    created = loaded.exports.d3d11CreateDevice(null, 1, 0, 0, null, 7),
    device = created.device,
    ctx = created.immediateContext,
    cache = new EmoteD3d11Textures(device);
  const cases = [
    ['L8', 'common', 61, 3, 7, 5],
    ['A8', 'common', 65, 2, 7, 5],
    ['A8L8', 'common', 49, 4, 14, 5],
    ['RGBA8', 'common', 28, 1, 28, 5],
    ['RGBX8', 'common', 28, 1, 28, 5],
    ['RGBA8', 'win', 87, 1, 28, 5],
    ['RGBX8', 'win', 87, 1, 28, 5],
    ['DXT1', 'win', 71, 1, 16, 2],
    ['DXT3', 'win', 74, 1, 32, 2],
    ['DXT5', 'win', 77, 1, 32, 2],
    ['BC7', 'win', 98, 1, 32, 2],
    ['DXT1', 'common', 71, 1, 16, 2],
    ['DXT3', 'common', 74, 1, 32, 2],
    ['DXT5', 'common', 77, 1, 32, 2],
  ];
  for (const [type, spec, format, kind, pitch, rows] of [
    ...cases,
    ...cases.filter((c) => c[1] === 'win').map(([t, ...args]) => [t + '_SW', ...args]),
    ['L8_SW', 'win', 61, 3, 7, 5],
    ['A8_SW', 'win', 65, 2, 7, 5],
    ['A8L8_SW', 'win', 49, 4, 14, 5],
  ]) {
    const compressed = [71, 74, 77, 98].includes(format),
      width = compressed ? 8 : 7,
      height = compressed ? 8 : 5,
      data = Uint8Array.from({length: pitch * rows + 13}, (_, i) => (i * 53 + 17) & 255),
      expected = data.slice(0, pitch * rows),
      source = {
        type,
        width,
        height,
        pixel: {bytes: data},
        truncatedWidth: 1,
        truncatedHeight: 1,
        mipMapLevel: 7,
        mipMap: [],
      },
      entry = cache.acquire(source, spec);
    assert.equal(cache.acquire(source, spec), entry);
    assert.equal(entry.kind, kind);
    const desc = entry.texture.getDesc();
    assert.equal(desc.format, format);
    assert.equal(desc.width, width);
    assert.equal(desc.height, height);
    assert.equal(desc.mipLevels, 1);
    assert.equal(desc.arraySize, 1);
    assert.equal(desc.usage, 0);
    assert.equal(desc.bindFlags, 8);
    assert.equal(entry.view.getDesc().texture2D.mipLevels, 1);
    data.fill(0); // Native resource storage owns the original initial-data copy.
    // Inspect actual factory-owned canonical storage. Texture CopyResource uses GPU
    // execution, verified by the numeric browser probe rather than faked in this test.
    const storage = entry.texture.storage(0);
    assert.equal(storage.rowPitch, pitch);
    assert.deepEqual(storage.bytes, expected);
    ctx.psSetShaderResources(0, [entry.view]);
    cache.release(source);
    cache.release(source);
    // The released atlas stays idle for a same-file player until the next draw.
    cache.retireIdle();
    const retained = ctx.psGetShaderResources(0, 1)[0];
    assert.equal(retained, entry.view);
    assert.equal(retained.getDesc().format, format);
    retained.release();
    ctx.psSetShaderResources(0, [null]);
    assert.equal(
      entry.view.queryInterface('00000000-0000-0000-c000-000000000046').hr,
      0x80004002 | 0,
    );
    assert.equal(
      entry.texture.queryInterface('00000000-0000-0000-c000-000000000046').hr,
      0x80004002 | 0,
    );
  }
  cache.dispose();
  cache.dispose();
  ctx.release();
  device.release();
  loaded.loader.dispose();
});

test('E-mote atlas creation is atomic when its native view factory fails and refuses unsupported or short sources', async () => {
  const {EmoteD3d11Textures} =
    await import('../dist/native/emotedriver/runtime/render/d3d11-textures.js');
  const host = capabilityContext(),
    loaded = exportsFor(() => host.gl),
    created = loaded.exports.d3d11CreateDevice(null, 1, 0, 0, null, 7),
    device = created.device;
  const resources = [];
  const cache = new EmoteD3d11Textures({
    createTexture2D: (...args) => {
      const r = device.createTexture2D(...args);
      resources.push(r.value);
      return r;
    },
    createShaderResourceView: () => ({hr: INVALID, value: null}),
  });
  const source = {type: 'BC7', width: 4, height: 4, pixel: {bytes: new Uint8Array(16)}};
  for (let i = 0; i < 2; i++)
    assert.throws(() => cache.acquire(source, 'win'), /view creation failed/);
  assert.equal(resources.length, 2);
  for (const r of resources)
    assert.equal(r.queryInterface('00000000-0000-0000-c000-000000000046').hr, 0x80004002 | 0);
  for (const [s, spec] of [
    [source, 'common'],
    [source, 'unknown'],
    [{...source, type: 'RGBA5650'}, 'win'],
    [{...source, type: 'A8_SW'}, 'common'],
    [{...source, width: -1}, 'win'],
    [{...source, pixel: {bytes: new Uint8Array(15)}}, 'win'],
  ])
    assert.throws(() => cache.acquire(s, spec));
  assert.equal(resources.length, 2); // Validation fails before native allocation.
  assert.throws(() => cache.release(source), /unowned/);
  cache.dispose();
  assert.throws(() => cache.acquire(source, 'win'), /released/);
  created.immediateContext.release();
  device.release();
  loaded.loader.dispose();
});

test('E-mote native draw states use complete native descriptors and retire partial construction', async () => {
  const {EmoteD3d11Renderer} =
    await import('../dist/native/emotedriver/runtime/render/renderer-d3d11.js');
  const loaded = exportsFor(() => capabilityContext().gl);
  const created = loaded.exports.d3d11CreateDevice(null, 1, 0, 0, null, 7);
  const device = created.device,
    ctx = created.immediateContext;
  const resources = [],
    descriptors = [];
  const observe = (failSampler = 0) => {
    let samplers = 0;
    return new Proxy(device, {
      get(target, key) {
        const original = target[key];
        if (
          ![
            'createBlendState',
            'createDepthStencilState',
            'createRasterizerState',
            'createSamplerState',
          ].includes(key)
        )
          return typeof original === 'function' ? original.bind(target) : original;
        return (...args) => {
          descriptors.push([key, args[0]]);
          if (key === 'createSamplerState' && ++samplers === failSampler)
            return {hr: INVALID, value: null};
          const result = original.apply(target, args);
          if (result.value) resources.push(result.value);
          return result;
        };
      },
    });
  };
  // No draw is issued here; shader and atlas owners are borrowed but never consulted.
  assert.throws(() => new EmoteD3d11Renderer(observe(2), ctx, null, null), /state creation failed/);
  assert.equal(resources.length, 17);
  for (const resource of resources)
    assert.equal(
      resource.queryInterface('00000000-0000-0000-c000-000000000046').hr,
      0x80004002 | 0,
    );
  resources.length = descriptors.length = 0;
  const renderer = new EmoteD3d11Renderer(observe(), ctx, null, null);
  const blends = descriptors
    .filter(([name]) => name === 'createBlendState')
    .map(([, desc]) => desc);
  assert.equal(blends.length, 14);
  for (const [index, desc] of blends.slice(0, 13).entries()) {
    assert.equal(desc.renderTarget.length, 8);
    assert.equal(desc.independentBlendEnable, false);
    assert.equal(desc.renderTarget[0].blendEnable, index !== 8);
    assert.equal(desc.renderTarget[0].renderTargetWriteMask, 15);
    for (const unused of desc.renderTarget.slice(1))
      for (const [key, value] of Object.entries(unused))
        assert.equal(value, key === 'blendEnable' ? false : 0);
  }
  // Native stencil mask draws use row8's disabled blend with color writes suppressed.
  assert.deepEqual(blends[13], {
    ...blends[8],
    renderTarget: blends[8].renderTarget.map((target) => ({...target, renderTargetWriteMask: 0})),
  });
  // Native row8 disables blending; row12 preserves destination alpha.
  assert.equal(blends[12].renderTarget[0].srcBlendAlpha, 1);
  assert.equal(blends[12].renderTarget[0].destBlendAlpha, 2);
  const raster = descriptors.find(([name]) => name === 'createRasterizerState')[1];
  assert.equal(raster.scissorEnable, true);
  assert.equal(raster.depthClipEnable, false);
  const samplers = descriptors
    .filter(([name]) => name === 'createSamplerState')
    .map(([, desc]) => desc);
  assert.deepEqual(
    samplers.map((desc) => desc.filter),
    [0, 21],
  );
  assert.ok(
    samplers.every((desc) => desc.addressU === 3 && desc.addressV === 3 && desc.addressW === 1),
  );
  const color = device.createTexture2D(textureDesc({format: 28}), null).value;
  const view = device.createRenderTargetView(color, null).value;
  const callerViewport = {
    topLeftX: 1,
    topLeftY: 2,
    width: 3,
    height: 2,
    minDepth: 0.25,
    maxDepth: 0.75,
  };
  ctx.rsSetViewports([callerViewport]);
  renderer.render(
    [],
    {texture: color, view, depth: null, width: 4, height: 4, subresource: 0},
    new Float32Array(16),
    false,
  );
  const bound = ctx.omGetRenderTargets(1);
  assert.equal(bound.views[0], view);
  bound.views[0].release();
  assert.deepEqual(ctx.rsGetScissorRects(), [{left: 0, top: 0, right: 4, bottom: 4}]);
  assert.deepEqual(ctx.rsGetViewports(), [callerViewport]);
  ctx.omSetRenderTargets([], null);
  ctx.rsSetState(null);
  ctx.omSetDepthStencilState(null, 0);
  view.release();
  color.release();
  renderer.dispose();
  renderer.dispose();
  for (const resource of resources)
    assert.equal(
      resource.queryInterface('00000000-0000-0000-c000-000000000046').hr,
      0x80004002 | 0,
    );
  assert.throws(() => renderer.render([], null, new Float32Array(16), false), /released/);
  ctx.release();
  device.release();
  loaded.loader.dispose();
});

test('E-mote external targets retain native views/resources without rebinding the compositor', async () => {
  const {EmoteD3d11Target} =
    await import('../dist/native/emotedriver/runtime/render/d3d11-target.js');
  const loaded = exportsFor(() => capabilityContext().gl);
  const {device, immediateContext: ctx} = loaded.exports.d3d11CreateDevice(null, 1, 0, 0, null, 7);
  const color = device.createTexture2D(
    textureDesc({format: 28, width: 8, height: 4, mipLevels: 2}),
    null,
  ).value;
  const view = device.createRenderTargetView(color, {
    format: 28,
    viewDimension: 4,
    texture2D: {mipSlice: 1},
  }).value;
  const depth = device.createTexture2D(
    textureDesc({format: 45, width: 8, height: 4, mipLevels: 2, bindFlags: 0x40}),
    null,
  ).value;
  const depthView = device.createDepthStencilView(depth, {
    format: 45,
    viewDimension: 3,
    flags: 0,
    texture2D: {mipSlice: 1},
  }).value;
  const holder = new EmoteD3d11Target(view, depthView);
  assert.deepEqual(ctx.omGetRenderTargets(1), {views: [null], depthStencilView: null});
  assert.equal(holder.binding.view, view);
  assert.equal(holder.binding.depth, depthView);
  assert.equal(holder.binding.texture, color);
  assert.equal(holder.binding.width, 8);
  assert.equal(holder.binding.height, 4);
  assert.equal(holder.binding.subresource, 0);
  color.release();
  view.release();
  depth.release();
  depthView.release();
  assert.equal(holder.binding.texture.getDesc().width, 8);
  // Context bindings retain their own references, independently of this owner.
  ctx.omSetRenderTargets([view], depthView);
  holder.dispose();
  holder.dispose();
  assert.throws(() => holder.binding, /released/);
  const retained = ctx.omGetRenderTargets(1);
  assert.equal(retained.views[0], view);
  assert.equal(retained.depthStencilView, depthView);
  retained.views[0].release();
  retained.depthStencilView.release();
  ctx.omSetRenderTargets([], null);
  for (const resource of [color, view, depth, depthView])
    assert.equal(
      resource.queryInterface('00000000-0000-0000-c000-000000000046').hr,
      0x80004002 | 0,
    );
  ctx.release();
  device.release();
  loaded.loader.dispose();
});

test('E-mote target construction unwinds native references when a later resource query fails', async () => {
  const {EmoteD3d11Target} =
    await import('../dist/native/emotedriver/runtime/render/d3d11-target.js');
  const loaded = exportsFor(() => capabilityContext().gl);
  const {device, immediateContext: ctx} = loaded.exports.d3d11CreateDevice(null, 1, 0, 0, null, 7);
  const color = device.createTexture2D(textureDesc({format: 28}), null).value;
  const view = device.createRenderTargetView(color, null).value;
  // The borrowed depth contract fails before it transfers a resource reference.
  assert.throws(
    () =>
      new EmoteD3d11Target(view, {
        getResource() {
          throw Error('resource query failed');
        },
      }),
    /resource query failed/,
  );
  view.release();
  color.release();
  for (const resource of [color, view])
    assert.equal(
      resource.queryInterface('00000000-0000-0000-c000-000000000046').hr,
      0x80004002 | 0,
    );
  ctx.release();
  device.release();
  loaded.loader.dispose();
});

test('native E-mote matrix mode owns caller state and uploads noncommuting world/view/projection in the native layout', () => {
  const state = new EmoteD3d11Matrices();
  const world = Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1);
  state.setWorldMatrix(world);
  world.fill(999); // The public setter copied all64bytes synchronously.
  state.setViewMatrix([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  state.setProjectionMatrix([2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  assert.equal(state.getAutomaticMatrix(), true);
  state.setAutomaticMatrix(false);
  const expected = Float32Array.of(0, -2, 0, -40, 3, 0, 0, 30, 0, 0, 1, 0, 0, 0, 0, 1);
  assert.deepEqual(state.shaderMatrix(32, 24, 1), expected);
  assert.deepEqual(state.shaderMatrix(100, 80, 0), expected); // Manual words ignore screen size/mode.
  assert.throws(() => state.setViewMatrix([1, 2]), /Invalid E-mote matrix/);
  assert.deepEqual(state.shaderMatrix(32, 24, 1), expected);
});

test('native E-mote matrix composition rounds products and preserves SSE cancellation pairs', () => {
  const state = new EmoteD3d11Matrices();
  state.setAutomaticMatrix(false);
  state.setWorldMatrix([16777216, 1, -16777216, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  state.setViewMatrix([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  assert.equal(state.shaderMatrix(1, 1, 1)[0], 2); // A left fold of float32 sums yields1.
  state.setWorldMatrix([4097, 0, -16785408, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  state.setViewMatrix([4097, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(state.shaderMatrix(1, 1, 1)[0], 0); // A single final float32 rounding yields1.
});

test('automatic native E-mote camera replaces view/projection, ignores world and keeps exact target-sized shader words', () => {
  const state = new EmoteD3d11Matrices();
  state.setWorldMatrix(Array(16).fill(NaN)); // Auto preparation does not multiply world.
  const words = (value) => [...new Uint32Array(value.buffer, value.byteOffset, 16)];
  const expected = [
    0x3d800000, 0, 0, 0x80000000, 0, 0xbdaaaaab, 0, 0x80000000, 0, 0, 0x3dcccccd, 0xbf666666, 0, 0,
    0, 0x3f800000,
  ];
  assert.deepEqual(words(state.shaderMatrix(32, 24, 1)), expected);
  assert.deepEqual(words(state.shaderMatrix(32, 24, -1)), expected);
  assert.deepEqual(words(state.shaderMatrix(32, 24, 7)), expected);
  expected[5] = 0x3daaaaab;
  expected[10] = 0xbdcccccd;
  assert.deepEqual(words(state.shaderMatrix(32, 24, 0)), expected);
  state.setWorldMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  state.setAutomaticMatrix(false);
  const manual = state.shaderMatrix(200, 100, 1);
  // Auto left its actual camera matrices installed; manual composition consumes them.
  assert.equal(manual[0], 0.0625);
  assert.equal(manual[5], Math.fround(1 / 12));
  assert.equal(manual[14], -2);
});
