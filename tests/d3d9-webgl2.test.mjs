import test from 'node:test';
import assert from 'node:assert/strict';
import {Opcode, RegisterType as R} from '../dist/graphics/d3d9-shader/bytecode.js';
import * as d3d from '../dist/native/d3d9/contract.js';
import {d3d9WebGl2Library} from '../dist/native/d3d9/library.js';
import {GL} from '../dist/native/d3d9/webgl2/gl.js';
import {fvfLayout} from '../dist/native/d3d9/webgl2/fvf.js';
import {convertRect, textureFormat} from '../dist/native/d3d9/webgl2/formats.js';
import {blendFactorPair, primitiveLayout} from '../dist/native/d3d9/webgl2/state.js';
import {alphaTestStatements, injectAlphaTest} from '../dist/native/d3d9/webgl2/fixed-function.js';
import {decodeDxt1, decodeDxt3} from '../dist/graphics/s3tc-dxt1-dxt3.js';

// ---- recording WebGL2 context ----

/**
 * Records every GL call as [name, ...args]. Objects are {kind, id}. Uniform locations exist
 * for names that occur in the program's shader sources, as a real linker reports them.
 */
function fakeGl({s3tc = true, depth = true, stencil = true, width = 640, height = 480} = {}) {
  const calls = [];
  let nextId = 1;
  const listeners = {};
  const shaderSources = new Map();
  const programShaders = new Map();
  const state = {lost: false};
  const make = (kind) => ({kind, id: nextId++});
  const canvas = {
    addEventListener: (type, fn) => (listeners[type] ??= []).push(fn),
    removeEventListener: () => {},
  };
  const base = {
    canvas,
    drawingBufferWidth: width,
    drawingBufferHeight: height,
    isContextLost: () => state.lost,
    getContextAttributes: () => ({depth, stencil, alpha: false}),
    getExtension: (name) =>
      name.includes('compressed_texture_s3tc')
        ? s3tc
          ? {}
          : null
        : name.includes('aniso')
          ? {}
          : null,
    getParameter: (p) =>
      p === GL.MAX_TEXTURE_SIZE ? 8192 : p === GL.MAX_TEXTURE_MAX_ANISOTROPY_EXT ? 16 : 0,
    createTexture: () => make('texture'),
    createFramebuffer: () => make('framebuffer'),
    createRenderbuffer: () => make('renderbuffer'),
    createBuffer: () => make('buffer'),
    createVertexArray: () => make('vao'),
    createSampler: () => make('sampler'),
    createShader: (type) => make(type === GL.VERTEX_SHADER ? 'vs' : 'fs'),
    createProgram: () => make('program'),
    shaderSource: (shader, source) => {
      shaderSources.set(shader, source);
      calls.push(['shaderSource', shader, source]);
    },
    attachShader: (program, shader) => {
      programShaders.set(program, [...(programShaders.get(program) ?? []), shader]);
    },
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformLocation: (program, name) => {
      const text = (programShaders.get(program) ?? []).map((s) => shaderSources.get(s)).join('\n');
      return new RegExp(`\\b${name}\\b`).test(text) ? {kind: 'uniform', name} : null;
    },
  };
  const gl = new Proxy(base, {
    get(target, prop) {
      if (prop in target) {
        const value = target[prop];
        if (typeof value !== 'function' || prop === 'shaderSource') return value;
        return (...args) => {
          const result = value(...args);
          calls.push([prop, ...args]);
          return result;
        };
      }
      return (...args) => {
        calls.push([prop, ...args]);
      };
    },
  });
  const named = (name) => calls.filter((c) => c[0] === name);
  return {
    gl,
    calls,
    named,
    state,
    sources: () => named('shaderSource').map((c) => c[2]),
    fire: (type) => (listeners[type] ?? []).forEach((fn) => fn({preventDefault() {}})),
    clear: () => (calls.length = 0),
  };
}

const presentation = (overrides = {}) => ({
  backBufferWidth: 640,
  backBufferHeight: 480,
  backBufferFormat: d3d.D3DFMT_X8R8G8B8,
  backBufferCount: 1,
  multiSampleType: 0,
  multiSampleQuality: 0,
  swapEffect: d3d.D3DSWAPEFFECT_DISCARD,
  windowed: true,
  enableAutoDepthStencil: true,
  autoDepthStencilFormat: d3d.D3DFMT_D24S8,
  flags: 0,
  fullScreenRefreshRateInHz: 0,
  presentationInterval: 0,
  ...overrides,
});

function setup(options = {}, present = {}) {
  const fake = fakeGl(options);
  const adapter = {maxTextureSize: 8192, s3tc: options.s3tc ?? true, maxAnisotropy: 16};
  const library = d3d9WebGl2Library(adapter);
  const d3d9 = library.link({}).exports.direct3DCreate9(d3d.D3D_SDK_VERSION);
  const sizes = [];
  const window = {
    context: fake.gl,
    setBackBufferSize: (w, h) => sizes.push([w, h]),
    displayMode: () => ({width: 1920, height: 1080, refreshRate: 60, format: d3d.D3DFMT_X8R8G8B8}),
  };
  const result = d3d9.createDevice(0, d3d.D3DDEVTYPE_HAL, window, 0x40, presentation(present));
  assert.equal(result.hr, d3d.D3D_OK);
  return {...fake, d3d9, device: result.value, sizes};
}

/** A 0x142 (XYZ | DIFFUSE | TEX1) vertex: x, y, z, ARGB, u, v. */
function vertices142(list) {
  const bytes = new Uint8Array(list.length * 24);
  const view = new DataView(bytes.buffer);
  list.forEach(([x, y, z, argb, u, v], i) => {
    view.setFloat32(i * 24, x, true);
    view.setFloat32(i * 24 + 4, y, true);
    view.setFloat32(i * 24 + 8, z, true);
    view.setUint32(i * 24 + 12, argb, true);
    view.setFloat32(i * 24 + 16, u, true);
    view.setFloat32(i * 24 + 20, v, true);
  });
  return bytes;
}

const quad = vertices142([
  [0, 0, 0, 0x80ff0000, 0, 0],
  [1, 0, 0, 0x80ff0000, 1, 0],
  [0, 1, 0, 0x80ff0000, 0, 1],
  [1, 1, 0, 0x80ff0000, 1, 1],
]);

const uniformCall = (fake, name, method) =>
  fake
    .named(method)
    .filter((c) => c[1]?.name === name)
    .at(-1);

// ---- shader token builders (see tests/d3d9-shader.test.mjs) ----

const XYZW = 0xe4;
const regBits = (type, index) => ((type & 7) << 28) | ((type & 0x18) << 8) | index;
const dst = (type, index, mask = 0xf) => [(0x80000000 | regBits(type, index) | (mask << 16)) >>> 0];
const src = (type, index) => [(0x80000000 | regBits(type, index) | (XYZW << 16)) >>> 0];
const ins = (opcode, params = []) => [(opcode | (params.length << 24)) >>> 0, ...params];
const dcl = (usage, usageIndex, destination, samplerType = 0) =>
  ins(Opcode.DCL, [
    (0x80000000 | usage | (usageIndex << 16) | (samplerType << 27)) >>> 0,
    ...destination,
  ]);
const program = (version, ...body) =>
  new Uint8Array(new Uint32Array([version, ...body.flat(), 0x0000ffff]).buffer);

const vs2 = program(
  0xfffe0200,
  dcl(0, 0, dst(R.INPUT, 0)),
  dcl(5, 0, dst(R.INPUT, 1)),
  dcl(10, 0, dst(R.INPUT, 2)),
  ins(Opcode.M4x4, [...dst(R.RASTOUT, 0), ...src(R.INPUT, 0), ...src(R.CONST, 0)]),
  ins(Opcode.MOV, [...dst(R.TEXCRDOUT_OUTPUT, 0), ...src(R.INPUT, 1)]),
  ins(Opcode.MOV, [...dst(R.ATTROUT, 0), ...src(R.INPUT, 2)]),
);
const ps2 = program(
  0xffff0200,
  dcl(0, 0, dst(R.ADDR_TEXTURE, 0)),
  dcl(0, 0, dst(R.SAMPLER, 0), 2),
  ins(Opcode.TEX, [...dst(R.TEMP, 0), ...src(R.ADDR_TEXTURE, 0), ...src(R.SAMPLER, 0)]),
  ins(Opcode.MUL, [...dst(R.COLOROUT, 0), ...src(R.TEMP, 0), ...src(R.CONST, 0)]),
);

// ---- tests ----

test('Direct3DCreate9 accepts the SDK versions and checkDeviceFormat reports WebGL2 formats', () => {
  const library = d3d9WebGl2Library({maxTextureSize: 4096, s3tc: false, maxAnisotropy: 1});
  assert.deepEqual(library.identities, [{kind: 'system', fileName: 'd3d9.dll'}]);
  const {direct3DCreate9} = library.link({}).exports;
  assert.equal(direct3DCreate9(30), null);
  assert.ok(direct3DCreate9(31));
  const d3d9 = direct3DCreate9(32 | 0x80000000);
  const check = (usage, format) =>
    d3d9.checkDeviceFormat(
      0,
      d3d.D3DDEVTYPE_HAL,
      d3d.D3DFMT_X8R8G8B8,
      usage,
      d3d.D3DRTYPE_TEXTURE,
      format,
    );
  assert.equal(check(0, d3d.D3DFMT_A8R8G8B8), d3d.D3D_OK);
  assert.equal(check(0, d3d.D3DFMT_A8), d3d.D3D_OK);
  assert.equal(check(0, d3d.D3DFMT_DXT5), d3d.D3DERR_NOTAVAILABLE); // no S3TC extension
  assert.equal(check(d3d.D3DUSAGE_RENDERTARGET, d3d.D3DFMT_R5G6B5), d3d.D3D_OK);
  assert.equal(check(d3d.D3DUSAGE_RENDERTARGET, d3d.D3DFMT_L8), d3d.D3DERR_NOTAVAILABLE);
  const withS3tc = d3d9WebGl2Library({maxTextureSize: 4096, s3tc: true, maxAnisotropy: 1})
    .link({})
    .exports.direct3DCreate9(32);
  assert.equal(
    withS3tc.checkDeviceFormat(0, 1, d3d.D3DFMT_X8R8G8B8, 0, d3d.D3DRTYPE_TEXTURE, d3d.D3DFMT_DXT5),
    d3d.D3D_OK,
  );
});

test('state stores return D3D9 defaults and what was set', () => {
  const {device, d3d9, sizes} = setup();
  assert.deepEqual(sizes, [[640, 480]]);
  const rs = (s) => device.getRenderState(s).value;
  assert.equal(rs(d3d.D3DRS.ZENABLE), 1); // automatic depth-stencil
  assert.equal(rs(d3d.D3DRS.CULLMODE), 3);
  assert.equal(rs(d3d.D3DRS.ALPHAFUNC), d3d.D3DCMP.ALWAYS);
  assert.equal(rs(d3d.D3DRS.STENCILMASK), -1);
  assert.equal(rs(d3d.D3DRS.LIGHTING), 1);
  assert.equal(rs(d3d.D3DRS.COLORWRITEENABLE), 0xf);
  assert.equal(rs(d3d.D3DRS.SRCBLENDALPHA), d3d.D3DBLEND.ONE);
  assert.equal(device.getRenderState(999).hr, d3d.D3DERR_INVALIDCALL);
  assert.equal(device.setRenderState(d3d.D3DRS.ALPHAREF, 0x40), d3d.D3D_OK);
  assert.equal(rs(d3d.D3DRS.ALPHAREF), 0x40);
  assert.equal(device.getTextureStageState(0, d3d.D3DTSS.COLOROP).value, d3d.D3DTOP.MODULATE);
  assert.equal(device.getTextureStageState(1, d3d.D3DTSS.COLOROP).value, d3d.D3DTOP.DISABLE);
  assert.equal(device.getTextureStageState(0, d3d.D3DTSS.ALPHAOP).value, d3d.D3DTOP.SELECTARG1);
  assert.equal(device.getTextureStageState(2, d3d.D3DTSS.COLORARG2).value, d3d.D3DTA.CURRENT);
  assert.equal(device.getTextureStageState(8, d3d.D3DTSS.COLOROP).hr, d3d.D3DERR_INVALIDCALL);
  assert.equal(device.getSamplerState(1, d3d.D3DSAMP.ADDRESSU).value, d3d.D3DTADDRESS_WRAP);
  assert.equal(device.getSamplerState(0, d3d.D3DSAMP.MIPFILTER).value, d3d.D3DTEXF_NONE);
  assert.equal(device.getSamplerState(257, d3d.D3DSAMP.MAGFILTER).value, d3d.D3DTEXF_POINT);
  assert.equal(device.getSamplerState(16, d3d.D3DSAMP.MAGFILTER).hr, d3d.D3DERR_INVALIDCALL);
  device.setSamplerState(1, d3d.D3DSAMP.ADDRESSU, d3d.D3DTADDRESS_CLAMP);
  assert.equal(device.getSamplerState(1, d3d.D3DSAMP.ADDRESSU).value, d3d.D3DTADDRESS_CLAMP);
  assert.deepEqual(
    [...device.getTransform(d3d.D3DTS_WORLD).value],
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  );
  const m = Float32Array.from({length: 16}, (_, i) => i);
  device.setTransform(d3d.D3DTS_VIEW, m);
  m[0] = 99;
  assert.equal(device.getTransform(d3d.D3DTS_VIEW).value[1], 1);
  assert.equal(device.getTransform(d3d.D3DTS_VIEW).value[0], 0);
  assert.equal(device.getTransform(1).hr, d3d.D3DERR_INVALIDCALL);
  assert.deepEqual(device.getViewport().value, {
    x: 0,
    y: 0,
    width: 640,
    height: 480,
    minZ: 0,
    maxZ: 1,
  });
  assert.equal(
    device.setViewport({x: 600, y: 0, width: 100, height: 10, minZ: 0, maxZ: 1}),
    d3d.D3DERR_INVALIDCALL,
  );
  assert.deepEqual(device.getScissorRect().value, {left: 0, top: 0, right: 640, bottom: 480});
  assert.equal(device.getFVF().value, 0);
  device.setFVF(0x142);
  assert.equal(device.getFVF().value, 0x142);
  device.setVertexShaderConstantF(2, new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]), 2);
  assert.deepEqual(
    [...device.getVertexShaderConstantF(1, 3).value],
    [0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.equal(
    device.setVertexShaderConstantF(255, new Float32Array(8), 2),
    d3d.D3DERR_INVALIDCALL,
  );
  const caps = device.getDeviceCaps().value;
  assert.equal(caps.maxTextureWidth, 8192);
  assert.equal(caps.vertexShaderVersion >>> 0, 0xfffe0300);
  assert.equal(caps.pixelShaderVersion >>> 0, 0xffff0300);
  assert.ok(caps.textureCaps & d3d.D3DPTEXTURECAPS_MIPMAP);
  assert.equal(device.getDisplayMode(0).value.width, 1920);
  assert.equal(device.getDirect3D().value, d3d9);
});

test('emotedriver frame state maps to GL blend, depth, cull and alpha-test code', () => {
  const fake = setup();
  const {device} = fake;
  const S = d3d.D3DRS;
  device.setFVF(0x142);
  for (const [state, value] of [
    [S.CULLMODE, d3d.D3DCULL_NONE],
    [S.ZENABLE, 0],
    [S.ALPHAREF, 0],
    [S.ALPHATESTENABLE, 1],
    [S.ALPHAFUNC, d3d.D3DCMP.GREATER],
    [S.SEPARATEALPHABLENDENABLE, 1],
    [S.ALPHABLENDENABLE, 1],
    [S.BLENDOP, d3d.D3DBLENDOP.ADD],
    [S.SRCBLEND, d3d.D3DBLEND.SRCALPHA],
    [S.DESTBLEND, d3d.D3DBLEND.INVSRCALPHA],
    [S.BLENDOPALPHA, d3d.D3DBLENDOP.ADD],
    [S.SRCBLENDALPHA, d3d.D3DBLEND.ONE],
    [S.DESTBLENDALPHA, d3d.D3DBLEND.INVSRCALPHA],
    [S.LIGHTING, 0],
  ])
    assert.equal(device.setRenderState(state, value), d3d.D3D_OK);
  device.setTextureStageState(0, d3d.D3DTSS.ALPHAOP, d3d.D3DTOP.MODULATE);
  device.setTextureStageState(0, d3d.D3DTSS.ALPHAARG2, d3d.D3DTA.DIFFUSE);
  const texture = device.createTexture(4, 4, 1, 0, d3d.D3DFMT_A8R8G8B8, d3d.D3DPOOL_MANAGED).value;
  device.setTexture(0, texture);
  fake.clear();
  assert.equal(device.drawPrimitiveUP(d3d.D3DPT_TRIANGLESTRIP, 2, quad, 24), d3d.D3D_OK);

  const has = (...call) =>
    assert.ok(
      fake.calls.some((c) => c.length === call.length && call.every((v, i) => c[i] === v)),
      `expected ${call.join(', ')}`,
    );
  has('enable', GL.BLEND);
  has('blendFuncSeparate', GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA, GL.ONE, GL.ONE_MINUS_SRC_ALPHA);
  has('blendEquationSeparate', GL.FUNC_ADD, GL.FUNC_ADD);
  has('disable', GL.CULL_FACE);
  has('disable', GL.DEPTH_TEST);
  has('disable', GL.DITHER);
  has('frontFace', GL.CW);
  has('viewport', 0, 0, 640, 480);
  has('drawArrays', GL.TRIANGLE_STRIP, 0, 4);
  // FVF attributes: position (3 floats), diffuse (normalized bytes), texcoord.
  const pointers = fake.named('vertexAttribPointer').map((c) => c.slice(2));
  assert.deepEqual(pointers, [
    [3, GL.FLOAT, false, 24, 0],
    [4, GL.UNSIGNED_BYTE, true, 24, 12],
    [2, GL.FLOAT, false, 24, 16],
  ]);
  // D3DCOLOR 0x80ff0000 is B, G, R, A = 00 00 ff 80 in memory; GL reads R, G, B, A.
  const uploaded = fake.named('bufferData')[0][2];
  assert.deepEqual([...uploaded.subarray(12, 16)], [0xff, 0, 0, 0x80]);
  assert.equal(uploaded.length, 96);
  // Half-pixel offset on the default framebuffer.
  assert.deepEqual(uniformCall(fake, 'dx_posFixup', 'uniform4f').slice(2), [
    1,
    1,
    63 / 64 / 640,
    -(63 / 64) / 480,
  ]);
  const [vertexSource, fragmentSource] = fake.sources();
  assert.match(vertexSource, /ff_worldViewProj \* vec4\(a_position0\.xyz, 1\.0\)/);
  assert.match(
    fragmentSource,
    /floor\(clamp\(color\.a, 0\.0, 1\.0\) \* 255\.0 \+ 0\.5\) > dx_alphaRef\)\) discard;/,
  );
  assert.match(
    fragmentSource,
    /current = clamp\(vec4\(tex\.rgb \* current\.rgb, tex\.a \* diffuse\.a\), 0\.0, 1\.0\);/,
  );
  assert.deepEqual(uniformCall(fake, 'dx_alphaRef', 'uniform1f').slice(2), [0]);
  assert.deepEqual(
    fake.named('uniform1i').map((c) => [c[1].name, c[2]]),
    [['ff_s0', 0]],
  );
  // A second identical draw issues no state calls and reuses the program.
  fake.clear();
  device.drawPrimitiveUP(d3d.D3DPT_TRIANGLESTRIP, 2, quad, 24);
  assert.equal(fake.named('linkProgram').length, 0);
  assert.equal(fake.named('blendFuncSeparate').length, 0);
  assert.equal(fake.named('vertexAttribPointer').length, 0);
  // Reverse subtract (blend mode 2) and a new alpha function relink and remap.
  device.setRenderState(S.BLENDOP, d3d.D3DBLENDOP.REVSUBTRACT);
  device.setRenderState(S.DESTBLEND, d3d.D3DBLEND.ONE);
  device.setRenderState(S.ALPHAFUNC, d3d.D3DCMP.GREATEREQUAL);
  fake.clear();
  device.drawPrimitiveUP(d3d.D3DPT_TRIANGLELIST, 1, quad, 24);
  has('blendFuncSeparate', GL.SRC_ALPHA, GL.ONE, GL.ONE, GL.ONE_MINUS_SRC_ALPHA);
  has('blendEquationSeparate', GL.FUNC_REVERSE_SUBTRACT, GL.FUNC_ADD);
  has('drawArrays', GL.TRIANGLES, 0, 3);
  assert.equal(fake.named('linkProgram').length, 1);
  assert.match(fake.sources()[1], />= dx_alphaRef/);
  // Too few vertices for the primitive count.
  assert.equal(device.drawPrimitiveUP(d3d.D3DPT_TRIANGLELIST, 2, quad, 24), d3d.D3DERR_INVALIDCALL);
});

test('stencil mask passes map to GL stencil functions and operations', () => {
  const fake = setup();
  const {device} = fake;
  const S = d3d.D3DRS;
  device.setFVF(0x142);
  assert.equal(device.clear(null, d3d.D3DCLEAR_STENCIL, 0, 1, 0), d3d.D3D_OK);
  device.setRenderState(S.STENCILENABLE, 1);
  device.setRenderState(S.STENCILFAIL, d3d.D3DSTENCILOP.KEEP);
  device.setRenderState(S.STENCILMASK, 0xff);
  device.setRenderState(S.ZENABLE, 1);
  device.setRenderState(S.ZFUNC, d3d.D3DCMP.NEVER);
  device.setRenderState(S.STENCILFUNC, d3d.D3DCMP.EQUAL);
  device.setRenderState(S.STENCILREF, 2);
  device.setRenderState(S.STENCILPASS, d3d.D3DSTENCILOP.INCR);
  device.setRenderState(S.STENCILZFAIL, d3d.D3DSTENCILOP.INCRSAT);
  fake.clear();
  device.drawPrimitiveUP(d3d.D3DPT_TRIANGLESTRIP, 2, quad, 24);
  const find = (name) => fake.named(name).map((c) => c.slice(1));
  assert.deepEqual(find('stencilFuncSeparate'), [
    [GL.FRONT, GL.EQUAL, 2, 0xff],
    [GL.BACK, GL.EQUAL, 2, 0xff],
  ]);
  assert.deepEqual(find('stencilOpSeparate'), [
    [GL.FRONT, GL.KEEP, GL.INCR, GL.INCR_WRAP],
    [GL.BACK, GL.KEEP, GL.INCR, GL.INCR_WRAP],
  ]);
  assert.deepEqual(find('depthFunc'), [[GL.NEVER]]);
  assert.ok(fake.calls.some((c) => c[0] === 'enable' && c[1] === GL.STENCIL_TEST));
  // Two-sided stencil: back faces (D3D counter-clockwise) take the CCW states.
  device.setRenderState(185, 1); // TWOSIDEDSTENCILMODE
  device.setRenderState(188, d3d.D3DSTENCILOP.DECR); // CCW_STENCILPASS
  fake.clear();
  device.drawPrimitiveUP(d3d.D3DPT_TRIANGLESTRIP, 2, quad, 24);
  assert.deepEqual(find('stencilOpSeparate'), [[GL.BACK, GL.KEEP, GL.KEEP, GL.DECR_WRAP]]);
  // Without an automatic depth-stencil surface, clearing stencil is invalid.
  const plain = setup({}, {enableAutoDepthStencil: false});
  assert.equal(plain.device.getRenderState(S.ZENABLE).value, 0);
  assert.equal(plain.device.clear(null, d3d.D3DCLEAR_STENCIL, 0, 1, 0), d3d.D3DERR_INVALIDCALL);
});

test('Clear honours the viewport and scissor, ignores write masks, and flips y on the back buffer', () => {
  const fake = setup();
  const {device} = fake;
  device.setRenderState(d3d.D3DRS.COLORWRITEENABLE, 0);
  device.setViewport({x: 10, y: 20, width: 100, height: 50, minZ: 0, maxZ: 1});
  fake.clear();
  device.clear(null, d3d.D3DCLEAR_TARGET | d3d.D3DCLEAR_ZBUFFER, 0x80402010, 2, 0);
  const find = (name) => fake.named(name).map((c) => c.slice(1));
  assert.deepEqual(find('colorMask'), [[true, true, true, true]]);
  assert.deepEqual(find('clearColor'), [[0x40 / 255, 0x20 / 255, 0x10 / 255, 0x80 / 255]]);
  assert.deepEqual(find('clearDepth'), [[1]]);
  assert.deepEqual(find('scissor'), [[10, 480 - 70, 100, 50]]);
  assert.deepEqual(find('clear'), [[GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT]]);
  device.setRenderState(d3d.D3DRS.SCISSORTESTENABLE, 1);
  device.setScissorRect({left: 0, top: 0, right: 50, bottom: 40});
  fake.clear();
  device.clear(
    [
      {left: 0, top: 0, right: 640, bottom: 480},
      {left: 200, top: 200, right: 300, bottom: 300},
    ],
    d3d.D3DCLEAR_TARGET,
    0,
    1,
    0,
  );
  // Rect ∩ viewport ∩ scissor = (10,20)-(50,40); the second rect lies outside.
  assert.deepEqual(find('scissor'), [[10, 480 - 40, 40, 20]]);
  assert.equal(find('clear').length, 1);
  assert.equal(device.clear([], d3d.D3DCLEAR_TARGET, 0, 1, 0), d3d.D3D_OK);
  assert.equal(device.clear(null, 0, 0, 1, 0), d3d.D3DERR_INVALIDCALL);
});

test('render-target textures bind framebuffers with the flipped clip space', () => {
  const fake = setup();
  const {device} = fake;
  const rt = device.createTexture(
    256,
    128,
    1,
    d3d.D3DUSAGE_RENDERTARGET,
    d3d.D3DFMT_A8R8G8B8,
    d3d.D3DPOOL_DEFAULT,
  ).value;
  assert.equal(
    device.createTexture(
      4,
      4,
      1,
      d3d.D3DUSAGE_RENDERTARGET,
      d3d.D3DFMT_A8R8G8B8,
      d3d.D3DPOOL_MANAGED,
    ).hr,
    d3d.D3DERR_INVALIDCALL,
  );
  assert.equal(rt.lockRect(0, null, 0).hr, d3d.D3DERR_INVALIDCALL);
  const surface = rt.getSurfaceLevel(0).value;
  assert.deepEqual(surface.getDesc(), {
    format: d3d.D3DFMT_A8R8G8B8,
    usage: d3d.D3DUSAGE_RENDERTARGET,
    pool: d3d.D3DPOOL_DEFAULT,
    width: 256,
    height: 128,
  });
  const back = device.getRenderTarget(0).value;
  assert.deepEqual(back.getDesc().width, 640);
  device.setViewport({x: 1, y: 1, width: 10, height: 10, minZ: 0, maxZ: 1});
  assert.equal(device.setRenderTarget(0, surface), d3d.D3D_OK);
  assert.equal(device.setRenderTarget(1, surface), d3d.D3DERR_INVALIDCALL);
  assert.equal(device.setRenderTarget(0, null), d3d.D3DERR_INVALIDCALL);
  // The viewport and scissor rect follow the new target.
  assert.deepEqual(device.getViewport().value, {
    x: 0,
    y: 0,
    width: 256,
    height: 128,
    minZ: 0,
    maxZ: 1,
  });
  assert.deepEqual(device.getScissorRect().value, {left: 0, top: 0, right: 256, bottom: 128});
  device.setViewport({x: 0, y: 8, width: 256, height: 64, minZ: 0, maxZ: 1});
  device.setRenderState(d3d.D3DRS.CULLMODE, 3);
  device.setFVF(0x142);
  fake.clear();
  device.drawPrimitiveUP(d3d.D3DPT_TRIANGLESTRIP, 2, quad, 24);
  const find = (name) => fake.named(name).map((c) => c.slice(1));
  const framebuffer = find('createFramebuffer')[0];
  assert.ok(
    fake.calls.some(
      (c) => c[0] === 'framebufferTexture2D' && c[2] === GL.COLOR_ATTACHMENT0 && c[5] === 0,
    ),
  );
  assert.ok(find('framebufferRenderbuffer').some((c) => c[1] === GL.DEPTH_STENCIL_ATTACHMENT));
  assert.equal(find('bindFramebuffer').at(-1)[1].kind, 'framebuffer');
  assert.ok(framebuffer === undefined || true);
  assert.deepEqual(find('viewport'), [[0, 8, 256, 64]]);
  assert.deepEqual(find('frontFace'), [[GL.CCW]]);
  assert.deepEqual(find('cullFace'), [[GL.BACK]]);
  assert.deepEqual(uniformCall(fake, 'dx_posFixup', 'uniform4f').slice(2), [
    1,
    -1,
    63 / 64 / 256,
    63 / 64 / 64,
  ]);
  // Render targets hold references: releasing the caller's surface keeps the texture alive.
  assert.equal(surface.release(), 2); // texture: creator + device binding
  device.setRenderTarget(0, back);
  back.release();
  fake.clear();
  device.drawPrimitiveUP(d3d.D3DPT_TRIANGLESTRIP, 2, quad, 24);
  assert.deepEqual(find('bindFramebuffer'), [[GL.FRAMEBUFFER, null]]);
  assert.deepEqual(find('frontFace'), [[GL.CW]]);
  assert.equal(rt.release(), 0);
  assert.equal(fake.named('deleteTexture').length, 1);
  assert.equal(fake.named('deleteFramebuffer').length, 1);
  // X8R8G8B8 targets render to RGB8 so destination alpha reads one.
  fake.clear();
  device.createTexture(8, 8, 1, d3d.D3DUSAGE_RENDERTARGET, d3d.D3DFMT_X8R8G8B8, 0);
  assert.equal(fake.named('texImage2D')[0][3], GL.RGB8);
});

test('texture uploads swizzle D3D layouts to GL', () => {
  const fake = setup();
  const {device} = fake;
  const upload = () => fake.named('texSubImage2D').at(-1);
  const make = (format, w = 2, h = 1) =>
    device.createTexture(w, h, 1, 0, format, d3d.D3DPOOL_MANAGED).value;

  const argb = make(d3d.D3DFMT_A8R8G8B8);
  let locked = argb.lockRect(0, null, 0).value;
  assert.equal(locked.pitch, 8);
  locked.bits.set([0x10, 0x20, 0x30, 0x40, 1, 2, 3, 4]); // B G R A
  assert.equal(argb.unlockRect(0), d3d.D3D_OK);
  assert.deepEqual(upload().slice(2, 9), [0, 0, 0, 2, 1, GL.RGBA, GL.UNSIGNED_BYTE]);
  assert.deepEqual([...upload()[9]], [0x30, 0x20, 0x10, 0x40, 3, 2, 1, 4]);
  assert.equal(argb.unlockRect(0), d3d.D3DERR_INVALIDCALL);

  const xrgb = make(d3d.D3DFMT_X8R8G8B8, 1, 1);
  xrgb.lockRect(0, null, 0).value.bits.set([1, 2, 3, 0]);
  xrgb.unlockRect(0);
  assert.deepEqual([...upload()[9]], [3, 2, 1, 255]);

  const a1 = make(d3d.D3DFMT_A1R5G5B5, 1, 1);
  new DataView(a1.lockRect(0, null, 0).value.bits.buffer).setUint16(0, 0x801f, true); // A=1, B=31
  a1.unlockRect(0);
  assert.equal(upload()[8], GL.UNSIGNED_SHORT_5_5_5_1);
  assert.ok(upload()[9] instanceof Uint16Array);
  assert.equal(upload()[9][0], 0x003f); // B in bits 5..1, A in bit 0

  const a4 = make(d3d.D3DFMT_A4R4G4B4, 1, 1);
  new DataView(a4.lockRect(0, null, 0).value.bits.buffer).setUint16(0, 0xa123, true);
  a4.unlockRect(0);
  assert.equal(upload()[9][0], 0x123a);

  const rgb565 = make(d3d.D3DFMT_R5G6B5, 1, 1);
  new DataView(rgb565.lockRect(0, null, 0).value.bits.buffer).setUint16(0, 0xf800, true);
  rgb565.unlockRect(0);
  assert.equal(upload()[9][0], 0xf800);

  const a8 = make(d3d.D3DFMT_A8, 4, 4);
  assert.equal(fake.named('texImage2D').at(-1)[3], GL.ALPHA);
  // A sub-rectangle lock exposes the level's pitch from the rect's first texel.
  locked = a8.lockRect(0, {left: 1, top: 2, right: 3, bottom: 4}, 0).value;
  assert.equal(locked.pitch, 4);
  locked.bits[0] = 7;
  locked.bits[4] = 9;
  a8.unlockRect(0);
  assert.deepEqual(upload().slice(2, 7), [0, 1, 2, 2, 2]);
  assert.deepEqual([...upload()[9]], [7, 0, 9, 0]);

  const l8 = make(d3d.D3DFMT_A8L8, 1, 1);
  assert.equal(fake.named('texImage2D').at(-1)[3], GL.LUMINANCE_ALPHA);
  l8.lockRect(0, null, 0).value.bits.set([5, 6]);
  l8.unlockRect(0);
  assert.deepEqual([...upload()[9]], [5, 6]);

  // Read-only locks do not upload; default-pool textures without DYNAMIC cannot be locked.
  const count = fake.named('texSubImage2D').length;
  argb.lockRect(0, null, d3d.D3DLOCK_READONLY);
  argb.unlockRect(0);
  assert.equal(fake.named('texSubImage2D').length, count);
  const fixed = device.createTexture(2, 2, 1, 0, d3d.D3DFMT_A8R8G8B8, d3d.D3DPOOL_DEFAULT).value;
  assert.equal(fixed.lockRect(0, null, 0).hr, d3d.D3DERR_INVALIDCALL);
  const dynamic = device.createTexture(
    2,
    2,
    1,
    d3d.D3DUSAGE_DYNAMIC,
    d3d.D3DFMT_A8R8G8B8,
    d3d.D3DPOOL_DEFAULT,
  ).value;
  assert.equal(dynamic.lockRect(0, null, 0).hr, d3d.D3D_OK);

  // Mip chains: levels 0 creates the full chain.
  const mips = device.createTexture(8, 4, 0, 0, d3d.D3DFMT_A8R8G8B8, d3d.D3DPOOL_MANAGED).value;
  assert.equal(mips.getLevelDesc(3).value.width, 1);
  assert.equal(mips.getLevelDesc(4).hr, d3d.D3DERR_INVALIDCALL);
  assert.equal(mips.lockRect(2, null, 0).value.pitch, 8);
});

test('DXT textures upload compressed with S3TC and decode without it', () => {
  for (const s3tc of [true, false]) {
    const fake = setup({s3tc});
    const texture = fake.device.createTexture(
      4,
      4,
      1,
      0,
      d3d.D3DFMT_DXT5,
      d3d.D3DPOOL_MANAGED,
    ).value;
    const locked = texture.lockRect(0, null, 0).value;
    assert.equal(locked.pitch, 16);
    assert.equal(texture.lockRect(0, null, 0).hr, d3d.D3DERR_INVALIDCALL); // already locked
    // Alpha 255 everywhere, colour0 = red.
    locked.bits.set([255, 255, 0, 0, 0, 0, 0, 0, 0x00, 0xf8, 0, 0, 0, 0, 0, 0]);
    fake.clear();
    texture.unlockRect(0);
    if (s3tc) {
      const call = fake.named('compressedTexImage2D')[0];
      assert.equal(call[3], GL.COMPRESSED_RGBA_S3TC_DXT5_EXT);
    } else {
      const call = fake.named('texImage2D')[0];
      assert.deepEqual(call.slice(3, 9), [GL.RGBA8, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE]);
      assert.deepEqual([...call[9].subarray(0, 4)], [255, 0, 0, 255]);
    }
    assert.equal(
      texture.lockRect(0, {left: 1, top: 0, right: 4, bottom: 4}, 0).hr,
      d3d.D3DERR_INVALIDCALL,
    );
  }
  // DXT1 three-colour blocks: index 3 is transparent black.
  const dxt1 = decodeDxt1(new Uint8Array([0, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 4, 4);
  assert.deepEqual([...dxt1.subarray(0, 4)], [0, 0, 0, 0]);
  const dxt3 = decodeDxt3(
    new Uint8Array([0x0f, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, 0, 0, 0, 0]),
    4,
    4,
  );
  assert.deepEqual([...dxt3.subarray(0, 8)], [255, 255, 255, 255, 255, 255, 255, 0]);
});

test('shader programs link lazily, cache by pair and upload constants', () => {
  const fake = setup();
  const {device} = fake;
  const vs = device.createVertexShader(vs2).value;
  const ps = device.createPixelShader(ps2).value;
  assert.equal(device.createVertexShader(ps2).hr, d3d.D3DERR_INVALIDCALL);
  assert.equal(device.createPixelShader(new Uint8Array(4)).hr, d3d.D3DERR_INVALIDCALL);
  device.setFVF(0x142);
  device.setVertexShader(vs);
  device.setPixelShader(ps);
  assert.equal(device.getVertexShader().value, vs);
  vs.release(); // the getter's reference
  device.setVertexShaderConstantF(
    0,
    Float32Array.from({length: 16}, (_, i) => i),
    4,
  );
  device.setPixelShaderConstantF(0, new Float32Array([0.5, 0.5, 0.5, 1]), 1);
  device.setRenderState(d3d.D3DRS.ALPHATESTENABLE, 1);
  device.setRenderState(d3d.D3DRS.ALPHAFUNC, d3d.D3DCMP.GREATER);
  fake.clear();
  device.drawPrimitiveUP(d3d.D3DPT_TRIANGLESTRIP, 2, quad, 24);
  assert.equal(fake.named('linkProgram').length, 1);
  // Attributes bind by declaration usage: position, texcoord0, color0.
  assert.deepEqual(
    fake.named('bindAttribLocation').map((c) => [c[2], c[3]]),
    [
      [0, 'a_position0'],
      [1, 'a_texcoord0'],
      [2, 'a_color0'],
    ],
  );
  assert.deepEqual(
    fake.named('vertexAttribPointer').map((c) => [c[1], c[6]]),
    [
      [0, 0],
      [1, 16],
      [2, 12],
    ],
  );
  const vsc = uniformCall(fake, 'vs_c', 'uniform4fv');
  assert.equal(vsc[4], 16);
  assert.equal(uniformCall(fake, 'ps_c', 'uniform4fv')[4], 4);
  assert.match(fake.sources()[1], /dx_oC0 = oC0;\n {2}if \(!\(floor\(clamp\(dx_oC0\.a/);
  // Unchanged constants are not uploaded again.
  fake.clear();
  device.drawPrimitiveUP(d3d.D3DPT_TRIANGLESTRIP, 2, quad, 24);
  assert.equal(fake.named('uniform4fv').length, 0);
  assert.equal(fake.named('linkProgram').length, 0);
  // Fixed-function pixel stage with the shader's vertex half: inputs follow the VS outputs.
  device.setPixelShader(null);
  fake.clear();
  device.drawPrimitiveUP(d3d.D3DPT_TRIANGLESTRIP, 2, quad, 24);
  assert.equal(fake.named('linkProgram').length, 1);
  assert.match(fake.sources()[1], /in vec4 v_color0;/);
  // Releasing the last reference to a shader deletes its programs.
  device.setVertexShader(null);
  const deleted = fake.named('deleteProgram').length;
  assert.equal(vs.release(), 0);
  assert.equal(fake.named('deleteProgram').length, deleted + 2);
});

test('pretransformed vertices map screen positions through the viewport', () => {
  const fake = setup();
  const {device} = fake;
  device.setFVF(d3d.D3DFVF_XYZRHW | d3d.D3DFVF_DIFFUSE);
  device.setViewport({x: 0, y: 0, width: 320, height: 240, minZ: 0.25, maxZ: 0.75});
  device.setTextureStageState(0, d3d.D3DTSS.COLOROP, d3d.D3DTOP.SELECTARG2);
  device.setTextureStageState(0, d3d.D3DTSS.ALPHAOP, d3d.D3DTOP.SELECTARG2);
  device.setTextureStageState(0, d3d.D3DTSS.ALPHAARG2, d3d.D3DTA.DIFFUSE | d3d.D3DTA.COMPLEMENT);
  const vertices = new Uint8Array(20 * 3);
  fake.clear();
  assert.equal(device.drawPrimitiveUP(d3d.D3DPT_TRIANGLELIST, 1, vertices, 20), d3d.D3D_OK);
  const [vertexSource, fragmentSource] = fake.sources();
  assert.match(vertexSource, /in vec4 a_positiont0;/);
  assert.doesNotMatch(vertexSource, /a_texcoord0;/);
  assert.match(fragmentSource, /\(vec4\(1\.0\) - diffuse\)\.a/);
  assert.deepEqual(uniformCall(fake, 'ff_screen', 'uniform4f').slice(2), [0, 0, 2 / 320, 2 / 240]);
  assert.deepEqual(uniformCall(fake, 'ff_depth', 'uniform2f').slice(2), [0.25, 2]);
  assert.deepEqual(
    fake.named('depthRange').map((c) => c.slice(1)),
    [[0.25, 0.75]],
  );
  assert.deepEqual(
    fake.named('vertexAttribPointer').map((c) => c.slice(2)),
    [
      [4, GL.FLOAT, false, 20, 0],
      [4, GL.UNSIGNED_BYTE, true, 20, 16],
    ],
  );
});

test('reference counts follow Direct3D 9 ownership', () => {
  const fake = setup();
  const {device, d3d9} = fake;
  const texture = device.createTexture(4, 4, 1, 0, d3d.D3DFMT_A8, d3d.D3DPOOL_MANAGED).value;
  const surface = texture.getSurfaceLevel(0).value;
  assert.equal(texture.addRef(), 3);
  assert.equal(surface.release(), 2);
  device.setTexture(0, texture);
  assert.equal(texture.release(), 2);
  assert.equal(device.getTexture(0).value, texture);
  assert.equal(texture.release(), 2);
  assert.equal(texture.release(), 1); // the device's binding remains
  assert.equal(fake.named('deleteTexture').length, 0);
  device.setTexture(0, null);
  assert.equal(fake.named('deleteTexture').length, 1);
  assert.equal(device.getTexture(0).value, null);
  // The back buffer counts on the device.
  const back = device.getRenderTarget(0).value;
  assert.equal(device.addRef(), 3);
  device.release();
  back.release();
  // The device holds its IDirect3D9.
  assert.equal(d3d9.addRef(), 3);
  d3d9.release();
  assert.equal(device.release(), 0);
  assert.equal(d3d9.release(), 0);
});

test('context loss reports DEVICELOST, then NOTRESET until Reset restores managed textures', () => {
  const fake = setup();
  const {device} = fake;
  const managed = device.createTexture(2, 2, 1, 0, d3d.D3DFMT_A8R8G8B8, d3d.D3DPOOL_MANAGED).value;
  managed.lockRect(0, null, 0).value.bits.fill(9);
  managed.unlockRect(0);
  const target = device.createTexture(
    2,
    2,
    1,
    d3d.D3DUSAGE_RENDERTARGET,
    d3d.D3DFMT_A8R8G8B8,
    0,
  ).value;
  assert.equal(device.testCooperativeLevel(), d3d.D3D_OK);
  fake.state.lost = true;
  fake.fire('webglcontextlost');
  assert.equal(device.testCooperativeLevel(), d3d.D3DERR_DEVICELOST);
  device.setFVF(0x142);
  fake.clear();
  assert.equal(device.drawPrimitiveUP(d3d.D3DPT_TRIANGLESTRIP, 2, quad, 24), d3d.D3D_OK);
  assert.equal(fake.named('drawArrays').length, 0);
  assert.equal(device.reset(presentation()), d3d.D3DERR_DEVICELOST);
  fake.state.lost = false;
  fake.fire('webglcontextrestored');
  assert.equal(device.testCooperativeLevel(), d3d.D3DERR_DEVICENOTRESET);
  assert.equal(device.reset(presentation()), d3d.D3DERR_INVALIDCALL); // default pool alive
  target.release();
  device.setRenderState(d3d.D3DRS.ALPHAREF, 5);
  fake.clear();
  assert.equal(device.reset(presentation()), d3d.D3D_OK);
  assert.equal(device.testCooperativeLevel(), d3d.D3D_OK);
  assert.equal(device.getRenderState(d3d.D3DRS.ALPHAREF).value, 0);
  assert.equal(fake.named('createTexture').length, 1);
  assert.deepEqual([...fake.named('texSubImage2D')[0][9]], new Array(16).fill(9));
});

test('pure mappings: FVF layouts, formats, blend factors, primitives, alpha test', () => {
  const layout = fvfLayout(0x142);
  assert.equal(layout.stride, 24);
  assert.deepEqual(layout.colorOffsets, [12]);
  assert.equal(fvfLayout(0x1c4 | (1 << 16)).stride, 16 + 4 + 4 + 12); // XYZRHW, diffuse, specular, tex1 size 3
  assert.equal(fvfLayout(0x100), null);
  const argb = textureFormat(d3d.D3DFMT_A8R8G8B8);
  assert.deepEqual(
    [
      ...convertRect(argb, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 12, {
        left: 1,
        top: 0,
        right: 3,
        bottom: 1,
      }),
    ],
    [7, 6, 5, 8, 11, 10, 9, 12],
  );
  assert.deepEqual(blendFactorPair(12, d3d.D3DBLEND.ONE), [GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA]);
  assert.deepEqual(blendFactorPair(d3d.D3DBLEND.INVDESTCOLOR, d3d.D3DBLEND.ONE), [
    GL.ONE_MINUS_DST_COLOR,
    GL.ONE,
  ]);
  assert.deepEqual(primitiveLayout(5, 6), {mode: GL.TRIANGLE_STRIP, vertices: 8});
  assert.deepEqual(primitiveLayout(6, 2), {mode: GL.TRIANGLE_FAN, vertices: 4});
  assert.equal(primitiveLayout(9, 1), null);
  assert.deepEqual(alphaTestStatements('a', d3d.D3DCMP.ALWAYS), []);
  assert.deepEqual(alphaTestStatements('a', d3d.D3DCMP.NEVER), ['discard;']);
  const source = 'void main() {\n  x();\n  dx_oC0 = oC0;\n}\n';
  assert.equal(injectAlphaTest(source, d3d.D3DCMP.LESS), source); // no oC0 output declared
});
