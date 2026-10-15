import {fileURLToPath} from 'node:url';
import {
  parseSyntheticBrowserOptions,
  runSyntheticBrowserProbe,
} from './lib/synthetic-browser-probe.mjs';

/**
 * Runs synthetic Direct3D 9 draws through the WebGL2 device in headless Chromium and reads
 * back small framebuffers of solid colours: rasterisation conventions (half-pixel offset,
 * y orientation of the back buffer and of render-target textures), blending, alpha test,
 * stencil masks, texture formats, fixed-function combiners and translated shaders. Every
 * generated program is compiled and linked by the real driver. Nothing but generated
 * content is drawn; no screenshots are taken.
 */
async function pageMain() {
  const contract = await import('/runtime/native/d3d9/contract.js');
  const {d3d9WebGl2Library, describeWebGl2Adapter} =
    await import('/runtime/native/d3d9/library.js');
  const {Opcode, RegisterType: R} = await import('/runtime/graphics/d3d9-shader/bytecode.js');
  const W = 8,
    H = 8;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    depth: true,
    stencil: true,
    alpha: true,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
  });
  if (!gl) return {available: false, reason: 'WebGL2 unavailable'};
  const adapter = describeWebGl2Adapter(gl);
  const d3d9 = d3d9WebGl2Library(adapter).link({}).exports.direct3DCreate9(32);
  const created = d3d9.createDevice(
    0,
    contract.D3DDEVTYPE_HAL,
    {
      context: gl,
      setBackBufferSize: (w, h) => {
        canvas.width = w;
        canvas.height = h;
      },
      displayMode: () => ({width: W, height: H, refreshRate: 60, format: 22}),
    },
    0x40,
    {
      backBufferWidth: W,
      backBufferHeight: H,
      backBufferFormat: 21,
      backBufferCount: 1,
      multiSampleType: 0,
      multiSampleQuality: 0,
      swapEffect: 1,
      windowed: true,
      enableAutoDepthStencil: true,
      autoDepthStencilFormat: 75,
      flags: 0,
      fullScreenRefreshRateInHz: 0,
      presentationInterval: 0,
    },
  );
  const device = created.value;
  const S = contract.D3DRS;
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  /** Back buffer in D3D row order (row 0 at the top) as 0xRRGGBBAA numbers. */
  const readBack = () => {
    const pixels = new Uint8Array(W * H * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const rows = [];
    for (let y = 0; y < H; y++) {
      const row = [];
      const glRow = H - 1 - y;
      for (let x = 0; x < W; x++) {
        const i = (glRow * W + x) * 4;
        row.push(
          ((pixels[i] << 24) | (pixels[i + 1] << 16) | (pixels[i + 2] << 8) | pixels[i + 3]) >>> 0,
        );
      }
      rows.push(row);
    }
    return rows;
  };
  /** XYZRHW | DIFFUSE | TEX1 vertices: [x, y, argb, u, v]. */
  const rhw = (list) => {
    const bytes = new Uint8Array(list.length * 28);
    const view = new DataView(bytes.buffer);
    list.forEach(([x, y, argb, u = 0, v = 0], i) => {
      view.setFloat32(i * 28, x, true);
      view.setFloat32(i * 28 + 4, y, true);
      view.setFloat32(i * 28 + 8, 0.5, true);
      view.setFloat32(i * 28 + 12, 1, true);
      view.setUint32(i * 28 + 16, argb, true);
      view.setFloat32(i * 28 + 20, u, true);
      view.setFloat32(i * 28 + 24, v, true);
    });
    return bytes;
  };
  const rect = (l, t, r, b, argb, u0 = 0, v0 = 0, u1 = 1, v1 = 1) =>
    rhw([
      [l, t, argb, u0, v0],
      [r, t, argb, u1, v0],
      [l, b, argb, u0, v1],
      [r, b, argb, u1, v1],
    ]);
  const FVF_RHW = 0x004 | 0x040 | 0x100;
  const drawRect = (...args) => device.drawPrimitiveUP(5, 2, rect(...args), 28);
  const defaults = () => {
    device.setVertexShader(null);
    device.setPixelShader(null);
    device.setFVF(FVF_RHW);
    for (const [state, value] of [
      [S.ALPHABLENDENABLE, 0],
      [S.ALPHATESTENABLE, 0],
      [S.ZENABLE, 0],
      [S.STENCILENABLE, 0],
      [S.CULLMODE, 1],
      [S.LIGHTING, 0],
      [S.SCISSORTESTENABLE, 0],
      [S.SEPARATEALPHABLENDENABLE, 0],
      [S.BLENDOP, 1],
    ])
      device.setRenderState(state, value);
    device.setTexture(0, null);
    device.setTexture(1, null);
    device.setTextureStageState(0, 1, 3); // COLOROP SELECTARG2 (diffuse)
    device.setTextureStageState(0, 3, 0);
    device.setTextureStageState(0, 4, 3);
    device.setTextureStageState(0, 6, 0);
    device.setTextureStageState(1, 1, 1);
  };

  const results = [];
  const check = (name, actual, expected) => {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    results.push(pass ? {name, pass} : {name, pass, actual, expected});
  };
  const near = (name, actual, expected, tolerance = 2) => {
    const channels = (v) => [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    const a = channels(actual),
      e = channels(expected);
    const pass = a.every((c, i) => Math.abs(c - e[i]) <= tolerance);
    results.push(pass ? {name, pass} : {name, pass, actual: a, expected: e});
  };
  const mask = (rows, color) => rows.map((row) => row.map((v) => (v === color ? 1 : 0)).join(''));
  const RED = 0xff0000ff,
    BLACK = 0x000000ff;

  // 1. Clear and half-pixel rasterisation on the back buffer: a rect with edges at
  // half-integers covers exactly the pixels whose centres (integers) lie inside it.
  defaults();
  device.clear(null, 1, 0xff000000, 1, 0);
  check('clear', readBack()[3][3], BLACK);
  drawRect(1.5, 0.5, 4.5, 2.5, 0xffff0000);
  check('half-pixel back buffer', mask(readBack(), RED), [
    '00000000',
    '00111000',
    '00111000',
    '00000000',
    '00000000',
    '00000000',
    '00000000',
    '00000000',
  ]);

  // 2. Viewport and clear rects with D3D (top-left) coordinates.
  device.clear(null, 1, 0xff000000, 1, 0);
  device.setViewport({x: 4, y: 0, width: 4, height: 4, minZ: 0, maxZ: 1});
  device.clear([{left: 0, top: 0, right: 8, bottom: 8}], 1, 0xffff0000, 1, 0);
  device.setViewport({x: 0, y: 0, width: W, height: H, minZ: 0, maxZ: 1});
  check('clear honours viewport', mask(readBack(), RED).slice(0, 5), [
    '00001111',
    '00001111',
    '00001111',
    '00001111',
    '00000000',
  ]);

  // 3. Render-target texture: draw the pattern into it, then sample it onto the back buffer
  // with point filtering. The result must match drawing directly.
  const rt = device.createTexture(W, H, 1, 1, 21, 0).value;
  const rtSurface = rt.getSurfaceLevel(0).value;
  const backSurface = device.getRenderTarget(0).value;
  device.setRenderTarget(0, rtSurface);
  device.clear(null, 1, 0xff000000, 1, 0);
  drawRect(1.5, 0.5, 4.5, 2.5, 0xffff0000);
  drawRect(5.5, 5.5, 7.5, 7.5, 0xffff0000);
  device.setRenderTarget(0, backSurface);
  device.clear(null, 1, 0xff00ff00, 1, 0);
  device.setTexture(0, rt);
  device.setSamplerState(0, 5, 1);
  device.setSamplerState(0, 6, 1);
  device.setTextureStageState(0, 1, 2); // SELECTARG1 texture
  device.setTextureStageState(0, 2, 2);
  drawRect(-0.5, -0.5, W - 0.5, H - 0.5, 0xffffffff);
  check('render target orientation', mask(readBack(), RED), [
    '00000000',
    '00111000',
    '00111000',
    '00000000',
    '00000000',
    '00000000',
    '00000011',
    '00000011',
  ]);

  // 4. Blending: SRCALPHA/INVSRCALPHA, then REVSUBTRACT with ONE.
  defaults();
  device.clear(null, 1, 0xff0000ff, 1, 0);
  device.setRenderState(S.ALPHABLENDENABLE, 1);
  device.setRenderState(S.SRCBLEND, 5);
  device.setRenderState(S.DESTBLEND, 6);
  drawRect(-0.5, -0.5, 7.5, 7.5, 0x80ff0000);
  near('blend srcalpha', readBack()[4][4], 0x80007fbf);
  device.clear(null, 1, 0xff808080, 1, 0);
  device.setRenderState(S.BLENDOP, 3);
  device.setRenderState(S.DESTBLEND, 2);
  drawRect(-0.5, -0.5, 7.5, 7.5, 0x80400000);
  near('blend revsubtract', readBack()[4][4], 0x608080bf);

  // 5. Alpha test: ALPHAREF 0x40 with GREATER rejects alpha 0x40, GREATEREQUAL accepts it.
  defaults();
  device.clear(null, 1, 0xff000000, 1, 0);
  device.setRenderState(S.ALPHATESTENABLE, 1);
  device.setRenderState(S.ALPHAREF, 0x40);
  device.setRenderState(S.ALPHAFUNC, 5);
  drawRect(-0.5, -0.5, 7.5, 7.5, 0x40ff0000);
  check('alpha test greater', readBack()[2][2], BLACK);
  device.setRenderState(S.ALPHAFUNC, 7);
  drawRect(-0.5, -0.5, 7.5, 7.5, 0x40ff0000);
  check('alpha test greaterequal', readBack()[2][2], 0xff000040);

  // 6. Stencil mask as emotedriver draws it: Z never passes, Z-fail increments.
  defaults();
  device.clear(null, 1 | 4, 0xff000000, 1, 0);
  device.setRenderState(S.STENCILENABLE, 1);
  device.setRenderState(S.ZENABLE, 1);
  device.setRenderState(S.ZFUNC, 1);
  device.setRenderState(S.STENCILFUNC, 3);
  device.setRenderState(S.STENCILREF, 0);
  device.setRenderState(S.STENCILMASK, 0xff);
  device.setRenderState(S.STENCILZFAIL, 7);
  device.setRenderState(S.STENCILPASS, 7);
  drawRect(-0.5, -0.5, 3.5, 7.5, 0xffffffff);
  device.setRenderState(S.ZENABLE, 0);
  device.setRenderState(S.STENCILZFAIL, 1);
  device.setRenderState(S.STENCILPASS, 1);
  device.setRenderState(S.STENCILREF, 1);
  drawRect(-0.5, -0.5, 7.5, 7.5, 0xffff0000);
  check('stencil mask', mask(readBack(), RED)[0], '11110000');

  // 7. Texture formats, point-sampled with SELECTARG1(TEXTURE).
  const formatCases = [
    [21, 4, [0x10, 0x20, 0x30, 0xff], 0x302010ff],
    [22, 4, [0x10, 0x20, 0x30, 0x00], 0x302010ff],
    [23, 2, [0x00, 0xf8], 0xff0000ff],
    [25, 2, [0x1f, 0x80], 0x0000ffff],
    [26, 2, [0x0f, 0xf0], 0x0000ffff],
    [50, 1, [0x80], 0x808080ff],
    [51, 2, [0x40, 0xff], 0x404040ff],
  ];
  for (const [format, bytes, texel, expected] of formatCases) {
    defaults();
    device.clear(null, 1, 0xff000000, 1, 0);
    const texture = device.createTexture(1, 1, 1, 0, format, 1).value;
    texture.lockRect(0, null, 0).value.bits.set(texel.slice(0, bytes));
    texture.unlockRect(0);
    device.setTexture(0, texture);
    device.setTextureStageState(0, 1, 2);
    device.setTextureStageState(0, 2, 2);
    drawRect(-0.5, -0.5, 7.5, 7.5, 0xffffffff);
    near(`format ${format}`, readBack()[3][3], expected);
    device.setTexture(0, null);
    texture.release();
  }
  // DXT5 (compressed or decoded): one block, colour0 red, alpha 255.
  {
    defaults();
    const texture = device.createTexture(4, 4, 1, 0, 0x35545844, 1).value;
    texture
      .lockRect(0, null, 0)
      .value.bits.set([255, 255, 0, 0, 0, 0, 0, 0, 0, 0xf8, 0, 0, 0, 0, 0, 0]);
    texture.unlockRect(0);
    device.setTexture(0, texture);
    device.setTextureStageState(0, 1, 2);
    device.setTextureStageState(0, 2, 2);
    drawRect(-0.5, -0.5, 7.5, 7.5, 0xffffffff);
    near(`format DXT5 (${adapter.s3tc ? 'compressed' : 'decoded'})`, readBack()[3][3], RED);
    device.setTexture(0, null);
    texture.release();
  }

  // 8. Combiner: MODULATE2X of texture and diffuse, ALPHAREPLICATE|COMPLEMENT, TFACTOR.
  {
    defaults();
    const texture = device.createTexture(1, 1, 1, 0, 21, 1).value;
    texture.lockRect(0, null, 0).value.bits.set([0x40, 0x40, 0x40, 0xc0]);
    texture.unlockRect(0);
    device.setTexture(0, texture);
    device.setTextureStageState(0, 1, 5); // MODULATE2X
    device.setTextureStageState(0, 2, 2); // TEXTURE
    device.setTextureStageState(0, 3, 0); // DIFFUSE
    drawRect(-0.5, -0.5, 7.5, 7.5, 0xff808080);
    near('modulate2x', readBack()[1][1], 0x404040ff);
    device.setTextureStageState(0, 1, 2);
    device.setTextureStageState(0, 2, 2 | 0x10 | 0x20); // 1 - texture alpha, replicated
    drawRect(-0.5, -0.5, 7.5, 7.5, 0xffffffff);
    near('complement alphareplicate', readBack()[1][1], 0x3f3f3fff);
    device.setRenderState(S.TEXTUREFACTOR, 0xff00ff00);
    device.setTextureStageState(0, 2, 3); // TFACTOR
    drawRect(-0.5, -0.5, 7.5, 7.5, 0xffffffff);
    near('tfactor', readBack()[1][1], 0x00ff00ff);
    device.setTexture(0, null);
    texture.release();
  }

  // 9. Untransformed XYZ vertices through WORLD·VIEW·PROJECTION, culling and the y axis.
  {
    defaults();
    device.clear(null, 1, 0xff000000, 1, 0);
    device.setFVF(0x002 | 0x040);
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    device.setTransform(256, identity);
    device.setTransform(2, identity);
    // Projection scales y by 0.5 and shifts it up: clip y ∈ [0, 1] is the top half.
    device.setTransform(3, new Float32Array([1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0, 0, 0.5, 0, 1]));
    const xyz = (list) => {
      const bytes = new Uint8Array(list.length * 16);
      const view = new DataView(bytes.buffer);
      list.forEach(([x, y, argb], i) => {
        view.setFloat32(i * 16, x, true);
        view.setFloat32(i * 16 + 4, y, true);
        view.setFloat32(i * 16 + 8, 0.5, true);
        view.setUint32(i * 16 + 12, argb, true);
      });
      return bytes;
    };
    // Clockwise on screen (D3D front face): top-left, top-right, bottom-left.
    const strip = xyz([
      [-1, 1, 0xffff0000],
      [1, 1, 0xffff0000],
      [-1, -1, 0xffff0000],
      [1, -1, 0xffff0000],
    ]);
    device.setRenderState(S.CULLMODE, 3); // cull counter-clockwise
    device.drawPrimitiveUP(5, 2, strip, 16);
    check(
      'xyz transform',
      mask(readBack(), RED)
        .map((r) => r[0])
        .join(''),
      '11110000',
    );
    device.clear(null, 1, 0xff000000, 1, 0);
    device.setRenderState(S.CULLMODE, 2); // cull clockwise
    device.drawPrimitiveUP(5, 2, strip, 16);
    check('cull clockwise', mask(readBack(), RED).join('').includes('1'), false);
    // Same in a render target, sampled back.
    device.setRenderState(S.CULLMODE, 3);
    device.setRenderTarget(0, rtSurface);
    device.clear(null, 1, 0xff000000, 1, 0);
    device.drawPrimitiveUP(5, 2, strip, 16);
    device.setRenderTarget(0, backSurface);
    defaults();
    device.setTexture(0, rt);
    device.setTextureStageState(0, 1, 2);
    device.setTextureStageState(0, 2, 2);
    drawRect(-0.5, -0.5, W - 0.5, H - 0.5, 0xffffffff);
    check(
      'xyz into render target',
      mask(readBack(), RED)
        .map((r) => r[0])
        .join(''),
      '11110000',
    );
    device.setTexture(0, null);
  }

  // 10. Translated shaders: vs_2_0 passes position and colour, ps_2_0 multiplies by c0.
  {
    const XYZW = 0xe4;
    const regBits = (type, index) => ((type & 7) << 28) | ((type & 0x18) << 8) | index;
    const dst = (type, index, m = 0xf) => [(0x80000000 | regBits(type, index) | (m << 16)) >>> 0];
    const src = (type, index) => [(0x80000000 | regBits(type, index) | (XYZW << 16)) >>> 0];
    const ins = (opcode, params = []) => [(opcode | (params.length << 24)) >>> 0, ...params];
    const dcl = (usage, index, d) =>
      ins(Opcode.DCL, [(0x80000000 | usage | (index << 16)) >>> 0, ...d]);
    const program = (version, ...body) =>
      new Uint8Array(new Uint32Array([version, ...body.flat(), 0x0000ffff]).buffer);
    const vs = device.createVertexShader(
      program(
        0xfffe0200,
        dcl(0, 0, dst(R.INPUT, 0)),
        dcl(10, 0, dst(R.INPUT, 1)),
        ins(Opcode.M4x4, [...dst(R.RASTOUT, 0), ...src(R.INPUT, 0), ...src(R.CONST, 0)]),
        ins(Opcode.MOV, [...dst(R.ATTROUT, 0), ...src(R.INPUT, 1)]),
      ),
    ).value;
    const ps = device.createPixelShader(
      program(
        0xffff0200,
        dcl(0, 0, dst(R.INPUT, 0)),
        ins(Opcode.MUL, [...dst(R.COLOROUT, 0), ...src(R.INPUT, 0), ...src(R.CONST, 0)]),
      ),
    ).value;
    defaults();
    device.clear(null, 1, 0xff000000, 1, 0);
    device.setFVF(0x002 | 0x040);
    // cMat = transpose(identity): clip = position.
    device.setVertexShaderConstantF(
      0,
      new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      4,
    );
    device.setPixelShaderConstantF(0, new Float32Array([1, 0.5, 0, 1]), 1);
    device.setVertexShader(vs);
    device.setPixelShader(ps);
    const xyz = new Uint8Array(4 * 16);
    const view = new DataView(xyz.buffer);
    [
      [-1, 1],
      [1, 1],
      [-1, -1],
      [1, -1],
    ].forEach(([x, y], i) => {
      view.setFloat32(i * 16, x, true);
      view.setFloat32(i * 16 + 4, y, true);
      view.setFloat32(i * 16 + 8, 0.5, true);
      view.setUint32(i * 16 + 12, 0xffffffff, true);
    });
    check('shader pair draws', device.drawPrimitiveUP(5, 2, xyz, 16), 0);
    near('shader pair colour', readBack()[0][0], 0xff8000ff);
    device.setPixelShader(null);
    device.setTextureStageState(0, 1, 3);
    device.setTextureStageState(0, 3, 0);
    device.clear(null, 1, 0xff000000, 1, 0);
    check('vs + fixed pixel draws', device.drawPrimitiveUP(5, 2, xyz, 16), 0);
    near('vs + fixed pixel colour', readBack()[7][7], 0xffffffff);
    device.setVertexShader(null);
    device.setPixelShader(ps);
    device.setTransform(3, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
    device.clear(null, 1, 0xff000000, 1, 0);
    device.setRenderState(S.ALPHATESTENABLE, 1);
    device.setRenderState(S.ALPHAFUNC, 8);
    check('fixed vertex + ps draws', device.drawPrimitiveUP(5, 2, xyz, 16), 0);
    near('fixed vertex + ps colour', readBack()[7][0], 0xff8000ff);
    device.setRenderState(S.ALPHAFUNC, 1); // NEVER: injected discard
    device.clear(null, 1, 0xff000000, 1, 0);
    device.drawPrimitiveUP(5, 2, xyz, 16);
    check('ps alpha test never', readBack()[7][0], BLACK);
    device.setPixelShader(null);
    vs.release();
    ps.release();
  }
  console.warn = originalWarn;
  rt.release();
  rtSurface.release();
  backSurface.release();
  const failed = results.filter((r) => !r.pass);
  return {
    available: true,
    adapter: {s3tc: adapter.s3tc, maxTextureSize: adapter.maxTextureSize},
    cases: results.length,
    failed: failed.length,
    failures: failed,
    warnings,
  };
}

if (process.argv.includes('--help')) {
  console.log('Usage: node tools/probe-d3d9-webgl2.mjs [--browser path] [--output results.json]');
  console.log(
    'Draws synthetic content through the D3D9 WebGL2 device and checks read-back pixels. Build dist first with npm run build:runtime.',
  );
} else {
  try {
    const result = await runSyntheticBrowserProbe({
      options: parseSyntheticBrowserOptions(process.argv.slice(2)),
      pageMain,
      runtimeRoot: fileURLToPath(new URL('../dist/', import.meta.url)),
      name: 'vn-d3d9-webgl2',
    });
    console.log(
      JSON.stringify(
        {
          cases: result.cases,
          failed: result.failed,
          failures: result.failures,
          warnings: result.warnings,
        },
        null,
        2,
      ),
    );
    if (result.failed) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
