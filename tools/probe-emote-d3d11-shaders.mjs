import {readFile, readdir, stat, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {
  parseSyntheticBrowserOptions,
  runSyntheticBrowserProbe,
} from './lib/synthetic-browser-probe.mjs';

async function fixtures(driver, root) {
  const {extractEmoteX64ShaderBlobs} = await import(
    new URL('dist/native/emotedriver/runtime/render/shaders.js', root)
  );
  const image = await readFile(driver),
    bank = extractEmoteX64ShaderBlobs(image);
  if (!bank) throw Error('Driver image does not match the supported exact SHA-256');
  return {
    ...bank,
    vertex: bank.vertex.map((b) => Buffer.from(b).toString('base64')),
    pixel: bank.pixel.map((b) => Buffer.from(b).toString('base64')),
    driverSha256: createHash('sha256').update(image).digest('hex'),
  };
}

/** Original shader containers, generated textures/geometry, numeric readback; no game pixels/screenshots. */
async function pageMain(fixture) {
  const {NativeLibraryLoader} = await import('/runtime/platform/native-libraries.js');
  const {D3D11} = await import('/runtime/native/d3d11/contract.js');
  const {d3d11WebGl2Library} = await import('/runtime/native/d3d11/library.js');
  const {
    EmoteD3d11Shaders,
    emoteD3d11BasicShader,
    emoteD3d11BufferedShader,
    emoteD3d11MaskShader,
    emoteD3d11AlphaShader,
  } = await import('/runtime/native/emotedriver/runtime/render/d3d11-shaders.js');
  const {packEmoteD3d11Mesh, drawEmoteD3d11Mesh} =
    await import('/runtime/native/emotedriver/runtime/render/d3d11-mesh.js');
  const {EmoteD3d11Textures} =
    await import('/runtime/native/emotedriver/runtime/render/d3d11-textures.js');
  const canvas = document.createElement('canvas'),
    gl = canvas.getContext('webgl2', {antialias: false});
  if (!gl) return {available: false, reason: 'WebGL2 unavailable'};
  const loader = new NativeLibraryLoader([d3d11WebGl2Library(() => gl)], {
    locate: (fileName) => ({kind: 'system', fileName}),
  });
  const loaded = loader.load('d3d11.dll');
  if (loaded.status !== 'loaded') throw Error('D3D11 did not load');
  const created = loaded.library.exports(D3D11).d3d11CreateDevice(null, 1, 0, 0, null, 7);
  if (created.hr !== 0) throw Error('Native device creation failed');
  const device = created.device,
    ctx = created.immediateContext,
    objects = [],
    rows = [];
  const own = (r) => {
    if (r.hr !== 0 || !r.value) throw Error('Resource creation ' + r.hr);
    objects.push(r.value);
    return r.value;
  };
  const decode = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const bank = new EmoteD3d11Shaders(device, {
    ...fixture,
    vertex: fixture.vertex.map(decode),
    pixel: fixture.pixel.map(decode),
  });
  const texture = (format = 28, width = 4, height = 4, changes = {}, initial = null) =>
    own(
      device.createTexture2D(
        {
          width,
          height,
          mipLevels: 1,
          arraySize: 1,
          format,
          sampleDesc: {count: 1, quality: 0},
          usage: 0,
          bindFlags: 0x28,
          cpuAccessFlags: 0,
          miscFlags: 0,
          ...changes,
        },
        initial,
      ),
    );
  const target = texture(),
    rtv = own(device.createRenderTargetView(target, null)),
    staging = texture(28, 4, 4, {usage: 3, bindFlags: 0, cpuAccessFlags: 0x20000}),
    maskTarget = texture(65),
    maskRtv = own(device.createRenderTargetView(maskTarget, null)),
    maskStaging = texture(65, 4, 4, {usage: 3, bindFlags: 0, cpuAccessFlags: 0x20000});
  const textures = new EmoteD3d11Textures(device);
  const sample = (format, data) =>
    textures.acquire(
      {
        width: 1,
        height: 1,
        type: {28: 'RGBA8', 65: 'A8', 61: 'L8', 49: 'A8L8'}[format],
        pixel: {bytes: Uint8Array.from(data)},
      },
      'common',
    ).view;
  const source = sample(28, [85, 170, 255, 255]),
    alpha = sample(65, [128]),
    destination = sample(28, [17, 34, 51, 255]),
    gray = sample(61, [85]),
    luminanceAlpha = sample(49, [85, 128]);
  const raster = own(
    device.createRasterizerState({
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
    }),
  );
  const bytes = new Uint8Array(4 * 20),
    view = new DataView(bytes.buffer);
  const vertices = [
    [-1, 1],
    [-1, -1],
    [1, 1],
    [1, -1],
  ];
  const colors = (color) => {
    vertices.forEach(([x, y], i) => {
      const o = i * 20;
      view.setFloat32(o, x, true);
      view.setFloat32(o + 4, y, true);
      bytes.set([color[2], color[1], color[0], color[3]], o + 8);
      view.setFloat32(o + 12, 0.5, true);
      view.setFloat32(o + 16, 0.5, true);
    });
  };
  colors([170, 85, 0, 255]);
  const buffer = own(
    device.createBuffer(
      {
        byteWidth: bytes.length,
        usage: 0,
        bindFlags: 1,
        cpuAccessFlags: 0,
        miscFlags: 0,
        structureByteStride: 0,
      },
      {data: bytes, rowPitch: 0, slicePitch: 0},
    ),
  );
  const vertex = bank.vertex(1);
  vertex.setFloats('modelViewProj', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  ctx.rsSetViewports([{topLeftX: 0, topLeftY: 0, width: 4, height: 4, minDepth: 0, maxDepth: 1}]);
  ctx.rsSetState(raster);
  ctx.iaSetPrimitiveTopology(5);
  ctx.iaSetVertexBuffers(0, [buffer], [20], [0]);
  let compared = 0;
  function draw(
    name,
    index,
    expected,
    {color = [170, 85, 0, 255], constants = {}, mask = false, atlas = source} = {},
  ) {
    colors(color);
    ctx.updateSubresource(buffer, 0, null, bytes, 0, 0);
    const pixel = bank.pixel(index);
    for (const [key, value] of Object.entries(constants)) pixel.setFloats(key, value);
    ctx.psSetShaderResources(0, [atlas, alpha, destination]);
    ctx.psSetSamplers(0, [null, null, null]);
    ctx.omSetRenderTargets([mask ? maskRtv : rtv], null);
    ctx.clearRenderTargetView(mask ? maskRtv : rtv, [0, 0, 0, 0]);
    vertex.bind(ctx);
    pixel.bind(ctx);
    ctx.draw(4, 0);
    ctx.copyResource(mask ? maskStaging : staging, mask ? maskTarget : target);
    const mapped = ctx.map(mask ? maskStaging : staging, 0, 1, 0);
    if (mapped.hr !== 0) throw Error('Map ' + mapped.hr);
    const actual = [...mapped.value.data],
      wanted = Array.from({length: 16}, () => expected).flat();
    ctx.unmap(mask ? maskStaging : staging, 0);
    compared += actual.length;
    rows.push({
      name,
      pixelIndex: index,
      passed: actual.length === wanted.length && actual.every((b, i) => b === wanted[i]),
      actual,
      expected: wanted,
    });
  }
  try {
    draw('native-basic-color', emoteD3d11BasicShader(0, 0, 0, 0, 0), [170, 85, 0, 255]);
    draw('native-basic-color-square', emoteD3d11BasicShader(0, 4, 0, 0, 0), [113, 28, 0, 255]);
    draw('native-basic-color-double', emoteD3d11BasicShader(0, 8, 0, 0, 0), [227, 57, 0, 255]);
    draw('native-basic-texture-modulation', emoteD3d11BasicShader(1, 4, 0, 0, 0), [57, 57, 0, 255]);
    draw(
      'native-basic-filter-constants',
      emoteD3d11BasicShader(0, 0, 0, 3, 0),
      [64, 128, 191, 255],
      {constants: {filterColor: [0.25, 0.5, 0.75, 1]}},
    );
    draw('native-screen-alpha-mask', emoteD3d11BasicShader(0, 0, 1, 0, 0), [170, 85, 0, 128], {
      constants: {screenMul: [0.25, 0.25]},
    });
    draw('native-buffered-add', emoteD3d11BufferedShader(1, 4, 0, 1), [102, 204, 255, 255], {
      color: [255, 255, 255, 255],
      constants: {screenMul: [0.25, 0.25], screenMulOffset: [0, 0, 0.5, 0.5]},
    });
    draw('native-A8-first-mask', emoteD3d11MaskShader(0, false, 0), [128], {
      color: [170, 85, 0, 128],
      mask: true,
    });
    draw('native-A8-alpha-multiply-add', emoteD3d11MaskShader(0, true, 0), [192], {
      color: [170, 85, 0, 128],
      mask: true,
      constants: {alphaMulAdd: [2, -0.25, 0, 0]},
    });
    draw('native-A8-mask-intersection', emoteD3d11MaskShader(0, false, 1), [64], {
      color: [170, 85, 0, 128],
      mask: true,
      constants: {screenMul: [0.25, 0.25]},
    });
    draw('native-alpha-ref-above', emoteD3d11AlphaShader(0), [0, 0, 0, 0], {
      color: [170, 85, 0, 128],
      constants: {alphaRef: [0.75]},
    });
    draw('native-alpha-ref-below', emoteD3d11AlphaShader(0), [170, 85, 0, 128], {
      color: [170, 85, 0, 128],
      constants: {alphaRef: [0.25]},
    });
    draw('native-alpha-ref-equality', emoteD3d11AlphaShader(0), [0, 0, 0, 0], {
      color: [170, 85, 0, 128],
      constants: {alphaRef: [Math.fround(128 / 255)]},
    });
    draw('native-L8-atlas', emoteD3d11BasicShader(3, 0, 0, 0, 0), [85, 85, 85, 255], {
      color: [255, 255, 255, 255],
      atlas: gray,
    });
    draw('native-A8L8-atlas', emoteD3d11BasicShader(4, 0, 0, 0, 0), [85, 85, 85, 128], {
      color: [255, 255, 255, 255],
      atlas: luminanceAlpha,
    });
    for (const [cols, meshRows] of [
      [1, 1],
      [2, 3],
      [17, 5],
      [1, 7],
      [7, 1],
    ]) {
      const points = new Float32Array((cols + 1) * (meshRows + 1) * 2);
      for (let j = 0; j <= meshRows; j++)
        for (let i = 0; i <= cols; i++) {
          const p = (j * (cols + 1) + i) * 2;
          points[p] = -1 + (2 * i) / cols;
          points[p + 1] = 1 - (2 * j) / meshRows;
        }
      const mesh = packEmoteD3d11Mesh(
        {cols, rows: meshRows, points},
        Uint32Array.of(0xffaa5500, 0xffaa5500, 0xffaa5500, 0xffaa5500),
        0,
        0,
        1,
        1,
        1,
        1,
      );
      ctx.omSetRenderTargets([rtv], null);
      ctx.clearRenderTargetView(rtv, [0, 0, 0, 0]);
      vertex.bind(ctx);
      bank.pixel(emoteD3d11BasicShader(0, 0, 0, 0, 0)).bind(ctx);
      drawEmoteD3d11Mesh(device, ctx, mesh);
      ctx.copyResource(staging, target);
      const mapped = ctx.map(staging, 0, 1, 0);
      if (mapped.hr !== 0) throw Error('Mesh Map ' + mapped.hr);
      const actual = [...mapped.value.data],
        expected = Array.from({length: 16}, () => [170, 85, 0, 255]).flat();
      ctx.unmap(staging, 0);
      compared += actual.length;
      rows.push({
        name: `native-packed-mesh-${cols}x${meshRows}`,
        vertexCount: mesh.vertexCount,
        topology: mesh.topology,
        passed: actual.length === expected.length && actual.every((b, i) => b === expected[i]),
        actual,
        expected,
      });
    }
    const gradientMesh = packEmoteD3d11Mesh(
      {cols: 1, rows: 1, points: Float32Array.of(-1, 1, 1, 1, -1, -1, 1, -1)},
      Uint32Array.of(0xff000000, 0xffff0000, 0xff00ff00, 0xffffff00),
      0,
      0,
      1,
      1,
      1,
      1,
    );
    ctx.clearRenderTargetView(rtv, [0, 0, 0, 0]);
    drawEmoteD3d11Mesh(device, ctx, gradientMesh);
    ctx.copyResource(staging, target);
    const mapped = ctx.map(staging, 0, 1, 0);
    if (mapped.hr !== 0) throw Error('Gradient mesh Map ' + mapped.hr);
    const actual = [...mapped.value.data],
      expected = [];
    for (const g of [32, 96, 159, 223])
      for (const r of [32, 96, 159, 223]) expected.push(r, g, 0, 255);
    ctx.unmap(staging, 0);
    compared += actual.length;
    rows.push({
      name: 'native-packed-mesh-BGRA-corner-gradient',
      passed: actual.length === expected.length && actual.every((b, i) => b === expected[i]),
      actual,
      expected,
    });
  } finally {
    bank.dispose();
    textures.dispose();
    for (const object of objects) object.release();
    ctx.release();
    device.release();
    loader.dispose();
  }
  rows.push({
    name: 'native-bank-final-device-retired',
    passed: device.queryInterface('db6f6ddb-ac77-4e88-8253-819df9bbf140').value === null,
  });
  const failures = rows.filter((r) => !r.passed);
  return {
    available: true,
    adapter: {vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER)},
    cases: rows.length,
    failed: failures.length,
    failures,
    rows,
    numericBytesCompared: compared,
    nativeShaderProgramsPrepared: 2089,
    nativeCpuInstructionsExecuted: false,
    nativeShaderSemanticsExecuted: true,
    generatedTexturesAndGeometry: true,
    gamePixels: false,
    screenshots: false,
    driverSha256: fixture.driverSha256,
  };
}

if (process.argv.includes('--help'))
  console.log(
    'Usage: node tools/probe-emote-d3d11-shaders.mjs --driver exact-driver.dll [--browser path] [--output new-results.json]',
  );
else
  try {
    const root = new URL('../', import.meta.url),
      args = process.argv.slice(2),
      driverAt = args.indexOf('--driver');
    if (driverAt < 0 || !args[driverAt + 1])
      throw Error('--driver requires an exact native DLL image');
    const driver = resolve(args.splice(driverAt, 2)[1]),
      paths = [
        driver,
        'tools/probe-emote-d3d11-shaders.mjs',
        'tools/lib/synthetic-browser-probe.mjs',
        'src/native/emotedriver/runtime/render/shaders.ts',
        'src/native/emotedriver/runtime/render/d3d11-program.ts',
        'src/native/emotedriver/runtime/render/d3d11-shaders.ts',
        'src/native/emotedriver/runtime/render/d3d11-mesh.ts',
        'src/native/emotedriver/runtime/render/vertex-colors.ts',
        'src/native/emotedriver/runtime/render/d3d11-textures.ts',
        'src/graphics/dxgi-layout.ts',
        'src/platform/native-libraries.ts',
      ];
    async function distFiles() {
      const found = [];
      for (const path of await readdir(new URL('dist/', root), {recursive: true}))
        if ((await stat(new URL('dist/' + path, root))).isFile()) found.push('dist/' + path);
      return found.sort();
    }
    for (const dir of ['src/native/d3d11/', 'src/graphics/d3d11-shader/'])
      for (const path of await readdir(new URL(dir, root), {recursive: true}))
        if (/\.ts$/.test(path)) paths.push(dir + path);
    const dist = await distFiles();
    paths.push(...dist);
    paths.sort();
    const files = [];
    for (let i = 0; i < paths.length; i += 32)
      files.push(
        ...(await Promise.all(
          paths.slice(i, i + 32).map(async (path) => {
            const absolute = fileURLToPath(new URL(path, root)),
              bytes = await readFile(absolute);
            return {
              path: absolute,
              bytes: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            };
          }),
        )),
      );
    const fixture = await fixtures(driver, root),
      fixtureSha256 = createHash('sha256').update(JSON.stringify(fixture)).digest('hex');
    const result = await runSyntheticBrowserProbe({
      options: parseSyntheticBrowserOptions(args),
      fixture,
      pageMain,
      runtimeRoot: fileURLToPath(new URL('dist/', root)),
      name: 'vn-emote-d3d11-shaders',
    });
    for (const f of files)
      if (
        createHash('sha256')
          .update(await readFile(f.path))
          .digest('hex') !== f.sha256
      )
        throw Error('Source/dist changed during public device probe: ' + f.path);
    if (JSON.stringify(dist) !== JSON.stringify(await distFiles()))
      throw Error('Complete compiled dist file set changed during public device probe');
    await writeFile(
      result.outputPath,
      JSON.stringify(
        {
          ...result,
          files,
          fullDistFileCount: dist.length,
          fixtureSha256,
          nodeVersion: process.version,
          head: execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: fileURLToPath(root),
            encoding: 'utf8',
          }).trim(),
          fullRenderCommandComparison: false,
          performanceAcceptanceComplete: false,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      JSON.stringify({cases: result.cases, failed: result.failed, failures: result.failures}),
    );
    if (!result.available || result.failed) process.exitCode = 1;
  } catch (error) {
    console.error(error.stack);
    process.exitCode = 1;
  }
