import {readFile, readdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {
  parseSyntheticBrowserOptions,
  runSyntheticBrowserProbe,
} from './lib/synthetic-browser-probe.mjs';

/** Synthetic numeric raster/output coverage; no game data, images or screenshots. */
async function pageMain() {
  const {D3d11Lifetime, D3d11Object} = await import('/runtime/native/d3d11/runtime/com.js');
  const {createTexture2DStorage} = await import('/runtime/native/d3d11/runtime/resources.js');
  const {createRenderTargetViewStorage, createDepthStencilViewStorage} =
    await import('/runtime/native/d3d11/runtime/views.js');
  const {D3d11GpuTextures} = await import('/runtime/native/d3d11/webgl2/textures.js');
  const {D3d11GpuOutput} = await import('/runtime/native/d3d11/webgl2/output.js');
  const gl = document.createElement('canvas').getContext('webgl2', {antialias: false});
  if (!gl) return {available: false, reason: 'WebGL2 unavailable'};
  const adapter = {
    vendor: gl.getParameter(gl.VENDOR),
    renderer: gl.getParameter(gl.RENDERER),
    version: gl.getParameter(gl.VERSION),
  };
  const resources = [],
    views = [],
    rows = [];
  let gpu, output;
  const lifetime = new D3d11Lifetime(() => {
    output?.dispose();
    gpu?.dispose();
  });
  const device = new D3d11Object(lifetime, [], () => {}, true),
    owner = {
      lifetime,
      device,
      resourceDestroyed: (r) => {
        output?.destroy(r);
        gpu?.destroy(r);
      },
      synchronizeResource: (r) => gpu?.synchronize(r),
    };
  gpu = new D3d11GpuTextures(owner, gl);
  output = new D3d11GpuOutput(owner, gl, gpu);
  const prefix = '#version 300 es\nprecision highp float;precision highp int;\n',
    shaders = [];
  function compile(type, body) {
    const s = gl.createShader(type);
    shaders.push(s);
    gl.shaderSource(s, prefix + body);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s));
    return s;
  }
  const program = gl.createProgram(),
    vao = gl.createVertexArray();
  gl.attachShader(
    program,
    compile(
      gl.VERTEX_SHADER,
      'uniform float z;uniform bool reverse;void main(){vec2 p[3]=vec2[3](vec2(-1,-1),vec2(3,-1),vec2(-1,3));int i=gl_VertexID;if(reverse&&i>0)i=3-i;gl_Position=vec4(p[i],2.0*z-1.0,1);}',
    ),
  );
  gl.attachShader(
    program,
    compile(
      gl.FRAGMENT_SHADER,
      // Linked programs place alpha in red for alpha-only targets.
      'uniform vec4 color;uniform int alphaTargets;layout(location=0)out vec4 first;layout(location=1)out vec4 second;void main(){first=color;second=vec4(1.0-color.rgb,color.a);if((alphaTargets&1)!=0)first.x=first.w;if((alphaTargets&2)!=0)second.x=second.w;}',
    ),
  );
  gl.linkProgram(program);
  for (const s of shaders) gl.deleteShader(s);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
  function texture(format = 28, bytes = null) {
    const result = createTexture2DStorage(
      owner,
      {
        width: 4,
        height: 4,
        mipLevels: 1,
        arraySize: 1,
        format,
        sampleDesc: {count: 1, quality: 0},
        usage: 0,
        bindFlags: [40, 45].includes(format) ? 0x40 : 0x28,
        cpuAccessFlags: 0,
        miscFlags: 0,
      },
      bytes ? [{data: bytes, rowPitch: 16, slicePitch: 0}] : null,
    );
    if (result.hr !== 0) throw Error('Texture creation failed ' + result.hr);
    resources.push(result.value);
    return result.value;
  }
  function view(resource, flags = 0) {
    const format = resource.getDesc().format,
      result = [40, 45].includes(format)
        ? createDepthStencilViewStorage(owner, resource, {
            format,
            viewDimension: 3,
            flags,
            texture2D: {mipSlice: 0},
          })
        : createRenderTargetViewStorage(owner, resource, null);
    if (result.hr !== 0) throw Error('View creation failed ' + result.hr);
    views.push(result.value);
    return result.value;
  }
  const raster = (overrides = {}) => ({
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
    ...overrides,
  });
  const face = (overrides = {}) => ({
    stencilFailOp: 1,
    stencilDepthFailOp: 1,
    stencilPassOp: 1,
    stencilFunc: 8,
    ...overrides,
  });
  const depth = (overrides = {}) => ({
    depthEnable: true,
    depthWriteMask: 1,
    depthFunc: 2,
    stencilEnable: false,
    stencilReadMask: 255,
    stencilWriteMask: 255,
    frontFace: face(),
    backFace: face(),
    ...overrides,
  });
  const targetBlend = (overrides = {}) => ({
    blendEnable: false,
    srcBlend: 2,
    destBlend: 1,
    blendOp: 1,
    srcBlendAlpha: 2,
    destBlendAlpha: 1,
    blendOpAlpha: 1,
    renderTargetWriteMask: 15,
    ...overrides,
  });
  const blend = (first = {}, second = {}, independent = false) => ({
    alphaToCoverageEnable: false,
    independentBlendEnable: independent,
    renderTarget: Array.from({length: 8}, (_, i) =>
      targetBlend(i === 0 ? first : i === 1 ? second : {}),
    ),
  });
  const rgba = texture(),
    rtv = view(rgba),
    alpha = texture(65),
    a8 = view(alpha),
    second = texture(),
    rtv2 = view(second);
  const base = {
    targets: [rtv],
    depthTarget: null,
    blend: null,
    blendFactor: [1, 1, 1, 1],
    sampleMask: 0xffffffff,
    depth: null,
    stencilRef: 0,
    raster: raster(),
    viewports: [{topLeftX: 0, topLeftY: 0, width: 4, height: 4, minDepth: 0, maxDepth: 1}],
    scissors: [],
  };
  const fill = (pixel) => Uint8Array.from(Array(16).fill(pixel).flat());
  const hash = async (a) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', a))]
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('');
  async function record(name, actual, expected) {
    let count = 0;
    const mismatches = [];
    for (let i = 0; i < actual.length; i++)
      if (actual[i] !== expected[i]) {
        count++;
        if (mismatches.length < 16)
          mismatches.push({index: i, actual: actual[i], expected: expected[i]});
      }
    rows.push({
      name,
      passed: count === 0,
      values: actual.length,
      mismatched: count,
      mismatches,
      actualSha256: await hash(actual),
      expectedSha256: await hash(expected),
    });
  }
  async function read(name, resource, expected) {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, gpu.framebuffer(resource, 0));
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.PACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.PACK_SKIP_ROWS, 0);
    const actual = new Uint8Array(64);
    gl.readPixels(0, 0, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, actual);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw Error('Output readback error ' + error);
    // Direct GL readback is physical; the native output uses top-left logical rows.
    // Alpha-only storage is red: its physical RGBA readback is (a, 0, 0, 1).
    const logical = actual.slice();
    if (gpu.flipped(resource))
      for (let y = 0; y < 4; y++) logical.set(actual.subarray(y * 16, (y + 1) * 16), (3 - y) * 16);
    if (resource.getDesc().format === 65)
      expected = Uint8Array.from(expected, (_, i) =>
        i % 4 === 0 ? expected[i + 3] : i % 4 === 3 ? 255 : 0,
      );
    await record(name, logical, expected);
  }
  function draw(changes = {}, color = [1, 0, 0, 1], z = 0.5, reverse = false) {
    const state = {...base, ...changes};
    if (!output.use(state)) return false;
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.uniform4fv(gl.getUniformLocation(program, 'color'), color);
    gl.uniform1f(gl.getUniformLocation(program, 'z'), z);
    gl.uniform1i(gl.getUniformLocation(program, 'reverse'), reverse ? 1 : 0);
    gl.uniform1i(
      gl.getUniformLocation(program, 'alphaTargets'),
      state.targets.reduce(
        (m, v, i) => (v?.resource.getDesc().format === 65 ? m | (1 << i) : m),
        0,
      ),
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw Error('Output draw error ' + error);
    output.written(state);
    return true;
  }
  const clear = (color = [0, 0, 0, 0]) => gpu.clearColor(rtv, color);
  try {
    clear();
    draw();
    // A lone first target draws through its resource framebuffer; several targets
    // use the private output framebuffer and its completeness cache.
    const resourceFramebuffer = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    draw({targets: [rtv, rtv2]});
    const outputFramebuffer = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
      originalStatus = gl.checkFramebufferStatus.bind(gl);
    rows.push({
      name: 'single-target-output-uses-resource-framebuffer',
      passed:
        resourceFramebuffer === gpu.framebuffer(rgba, 0) &&
        outputFramebuffer !== resourceFramebuffer,
    });
    let outputChecks = 0,
      allChecks = 0,
      rejectOutput = false,
      rejectAll = false;
    gl.checkFramebufferStatus = (target) => {
      allChecks++;
      if (rejectAll) return gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
      if (gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) === outputFramebuffer) {
        outputChecks++;
        if (rejectOutput) return gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
      }
      return originalStatus(target);
    };
    await read('ordinary-output', rgba, fill([255, 0, 0, 255]));
    // Readback and texture preparation use other framebuffers. Reusing the same
    // output must restore its binding and still render the next color exactly.
    draw({}, [0, 1, 0, 1]);
    await read('repeated-output-after-readback', rgba, fill([0, 255, 0, 255]));
    outputChecks = 0;
    allChecks = 0;
    draw({targets: [a8, rtv2]}, [0, 0, 0, 1]);
    draw({targets: [rtv, rtv2]});
    draw({targets: [a8, rtv2]}, [0, 0, 0, 0.5]);
    draw({targets: [rtv, rtv2]}, [0, 1, 0, 1]);
    rows.push({
      name: 'return-to-validated-output-configurations',
      passed: outputChecks === 1 && allChecks === 1,
      outputChecks,
      allChecks,
    });
    allChecks = 0;
    draw({targets: [a8]}, [0, 0, 0, 1]);
    draw();
    draw({targets: [a8]}, [0, 0, 0, 0.5]);
    draw({}, [0, 1, 0, 1]);
    rows.push({
      name: 'return-to-validated-single-target-framebuffers',
      passed: allChecks === 1,
      allChecks,
    });
    await read('restored-output-configuration', rgba, fill([0, 255, 0, 255]));
    const retryTexture = texture(),
      retryView = view(retryTexture);
    let incompleteRejected = false;
    rejectOutput = true;
    try {
      draw({targets: [retryView, rtv2]});
    } catch (error) {
      incompleteRejected = /Incomplete D3D11 draw output framebuffer/.test(String(error));
    } finally {
      rejectOutput = false;
    }
    const checksBeforeRetry = outputChecks;
    draw({targets: [retryView, rtv2]}, [0, 0, 1, 1]);
    rows.push({
      name: 'incomplete-output-is-not-cached',
      passed: incompleteRejected && outputChecks === checksBeforeRetry + 1,
    });
    await read('revalidated-output-after-failure', retryTexture, fill([0, 0, 255, 255]));
    const singleTexture = texture(),
      singleView = view(singleTexture);
    let singleRejected = false;
    rejectAll = true;
    try {
      draw({targets: [singleView]});
    } catch (error) {
      singleRejected = /Incomplete D3D11 framebuffer/.test(String(error));
    } finally {
      rejectAll = false;
    }
    const checksBeforeSingleRetry = allChecks;
    draw({targets: [singleView]}, [0, 0, 1, 1]);
    rows.push({
      name: 'incomplete-single-target-output-is-not-cached',
      passed: singleRejected && allChecks === checksBeforeSingleRetry + 1,
    });
    await read('revalidated-single-target-after-failure', singleTexture, fill([0, 0, 255, 255]));
    draw({targets: [rtv, rtv2]});
    for (let i = 0; i < 64; i++) draw({targets: [rtv, view(texture())]});
    const checksBeforeEvicted = outputChecks;
    draw({targets: [rtv, rtv2]});
    rows.push({
      name: 'bounded-output-cache-rechecks-evicted-configuration',
      passed: outputChecks === checksBeforeEvicted + 1,
    });
    clear();
    draw({
      raster: raster({scissorEnable: true}),
      scissors: [{left: 1, top: 2, right: 3, bottom: 4}],
    });
    await read(
      'native-row-scissor',
      rgba,
      Uint8Array.from(
        Array.from({length: 16}, (_, i) =>
          i % 4 >= 1 && i % 4 < 3 && Math.floor(i / 4) >= 2 ? [255, 0, 0, 255] : [0, 0, 0, 0],
        ).flat(),
      ),
    );
    clear();
    draw({
      raster: raster({scissorEnable: true}),
      scissors: [{left: -2147483648, top: -2147483648, right: 2147483647, bottom: 2147483647}],
    });
    await read('large-scissor-intersection', rgba, fill([255, 0, 0, 255]));
    clear();
    draw({raster: raster({scissorEnable: true})});
    await read('empty-scissor', rgba, fill([0, 0, 0, 0]));
    clear();
    draw({viewports: [{topLeftX: 1, topLeftY: 1, width: 2, height: 2, minDepth: 0, maxDepth: 1}]});
    await read(
      'native-viewport',
      rgba,
      Uint8Array.from(
        Array.from({length: 16}, (_, i) =>
          i % 4 >= 1 && i % 4 < 3 && Math.floor(i / 4) >= 1 && Math.floor(i / 4) < 3
            ? [255, 0, 0, 255]
            : [0, 0, 0, 0],
        ).flat(),
      ),
    );
    for (const z of [-0.5, 1.5]) {
      clear();
      draw({}, [1, 0, 0, 1], z);
      await read('depth-clip-' + z, rgba, fill([0, 0, 0, 0]));
      clear();
      draw({raster: raster({depthClipEnable: false})}, [1, 0, 0, 1], z);
      await read('depth-clamp-' + z, rgba, fill([255, 0, 0, 255]));
      clear();
      draw({}, [1, 0, 0, 1], z);
      await read('depth-clip-restored-' + z, rgba, fill([0, 0, 0, 0]));
    }
    for (const front of [false, true])
      for (const cull of [2, 3]) {
        clear();
        draw({raster: raster({frontCounterClockwise: front, cullMode: cull})});
        const visible = front ? cull === 3 : cull === 2;
        await read(
          'native-winding-' + front + '-' + cull,
          rgba,
          fill(visible ? [255, 0, 0, 255] : [0, 0, 0, 0]),
        );
      }
    clear();
    draw({raster: null});
    await read('native-null-raster-default', rgba, fill([0, 0, 0, 0]));
    for (const [name, changes] of [
      ['zero-sample-mask', {sampleMask: 0}],
      ['no-viewport', {viewports: []}],
      ['no-targets', {targets: []}],
    ]) {
      clear();
      const emitted = draw(changes);
      await read(name, rgba, fill([0, 0, 0, 0]));
      rows.push({name: name + '-no-emission', passed: !emitted});
    }
    clear([0, 0, 1, 1]);
    draw({blend: blend({blendEnable: true, srcBlend: 5, destBlend: 6})}, [1, 0, 0, 0.5]);
    await read('separate-alpha-blend', rgba, fill([128, 0, 128, 128]));
    clear([0.25, 0.75, 0.5, 1]);
    draw(
      {
        blend: blend({
          blendEnable: true,
          srcBlend: 1,
          destBlend: 1,
          blendOp: 4,
          srcBlendAlpha: 1,
          destBlendAlpha: 1,
          blendOpAlpha: 5,
        }),
      },
      [0.75, 0.25, 0.5, 0.25],
    );
    await read('min-max-ignore-factors', rgba, fill([64, 64, 128, 255]));
    clear([0, 1, 0, 1]);
    draw({blend: blend({renderTargetWriteMask: 5})}, [1, 0, 1, 0]);
    await read('component-write-mask', rgba, fill([255, 255, 255, 255]));
    gpu.clearColor(a8, [0, 0, 0, 0]);
    draw({targets: [a8]}, [1, 0.5, 0.25, 0.5]);
    await read('alpha-only-output', alpha, fill([0, 0, 0, 128]));
    await record('alpha-only-native-shadow', alpha.storage(0).bytes, new Uint8Array(16).fill(128));
    clear([0, 1, 0, 1]);
    gpu.clearColor(a8, [0, 0, 0, 0]);
    draw(
      {
        targets: [rtv, a8],
        blend: blend({renderTargetWriteMask: 1}, {renderTargetWriteMask: 8}, true),
      },
      [1, 0, 0, 0.5],
    );
    await read('independent-rgba-output', rgba, fill([255, 255, 0, 255]));
    await read('independent-a8-output', alpha, fill([0, 0, 0, 128]));
    const depthResource = texture(40),
      writable = view(depthResource),
      readOnly = view(depthResource, 1);
    gpu.clearDepthStencil(writable, 1, 0.75, 0);
    clear();
    draw({depthTarget: writable}, [1, 0, 0, 1], 0.25);
    draw({depthTarget: writable}, [0, 1, 0, 1], 0.5);
    await read('native-depth-write-test', rgba, fill([255, 0, 0, 255]));
    gpu.clearDepthStencil(writable, 1, 0.75, 0);
    clear();
    draw({depthTarget: readOnly}, [1, 0, 0, 1], 0.25);
    draw({depthTarget: writable}, [0, 1, 0, 1], 0.5);
    await read('read-only-depth-preserves-value', rgba, fill([0, 255, 0, 255]));
    const stencilResource = texture(45),
      stencilView = view(stencilResource),
      stencilReadOnly = view(stencilResource, 2);
    const replace = depth({
        depthEnable: false,
        stencilEnable: true,
        frontFace: face({stencilPassOp: 3}),
        backFace: face({stencilPassOp: 3}),
      }),
      equal = depth({
        depthEnable: false,
        stencilEnable: true,
        frontFace: face({stencilFunc: 3}),
        backFace: face({stencilFunc: 3}),
      });
    gpu.clearDepthStencil(stencilView, 3, 1, 0);
    clear();
    draw({depthTarget: stencilView, depth: replace, stencilRef: 0x5a});
    clear();
    draw({depthTarget: stencilView, depth: equal, stencilRef: 0x5a}, [0, 1, 0, 1]);
    await read('stencil-replace-compare', rgba, fill([0, 255, 0, 255]));
    draw({depthTarget: stencilReadOnly, depth: replace, stencilRef: 0xa5}, [0, 0, 1, 1]);
    draw({depthTarget: stencilView, depth: equal, stencilRef: 0x5a}, [0, 1, 0, 1]);
    await read('read-only-stencil-preserves-value', rgba, fill([0, 255, 0, 255]));
    const polygon = gl.getExtension('WEBGL_polygon_mode');
    if (polygon) {
      draw({raster: raster({fillMode: 2})});
      const bgr = texture(87, fill([0, 0, 255, 255]));
      gpu.image(bgr);
      await read('decoded-upload-after-wireframe', bgr, fill([255, 0, 0, 255]));
    } else rows.push({name: 'wireframe-extension-unavailable', passed: false});
    for (const changes of [
      {raster: raster({depthBias: 1})},
      {blend: blend({blendEnable: true, srcBlend: 16})},
    ]) {
      const revision = rgba.revision;
      let hr = null;
      try {
        draw(changes);
      } catch (error) {
        hr = error.hr;
      }
      rows.push({
        name: 'unsupported-output-state-' + JSON.stringify(changes),
        passed: hr === (0x80004001 | 0) && revision === rgba.revision,
        hr,
      });
    }
    draw({targets: [rtv, rtv2]});
    const fbo = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING),
      image = gpu.image(rgba),
      own = gpu.framebuffer(rgba, 0);
    rtv.release();
    views.splice(views.indexOf(rtv), 1);
    rgba.release();
    resources.splice(resources.indexOf(rgba), 1);
    rows.push({
      name: 'resource-retirement-detaches-output',
      passed:
        !rtv.live &&
        !rgba.live &&
        !gl.isTexture(image) &&
        gl.getFramebufferAttachmentParameter(
          gl.DRAW_FRAMEBUFFER,
          gl.COLOR_ATTACHMENT0,
          gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME,
        ) === null,
    });
    rows.push({
      name: 'resource-retirement-deletes-own-framebuffer',
      passed: !gl.isFramebuffer(own),
    });
    const replacement = texture(),
      replacementView = view(replacement);
    gpu.clearColor(replacementView, [0, 0, 0, 0]);
    draw({targets: [replacementView]}, [0, 0, 1, 1]);
    await read('output-after-attachment-retirement', replacement, fill([0, 0, 255, 255]));
    output.dispose();
    rows.push({name: 'output-framebuffer-disposed', passed: !gl.isFramebuffer(fbo)});
  } catch (error) {
    rows.push({name: 'output-exception', passed: false, error: error.stack});
  } finally {
    gl.useProgram(null);
    gl.deleteProgram(program);
    gl.deleteVertexArray(vao);
    output.dispose();
    for (const v of views) v.release();
    for (const r of resources) r.release();
    gpu.dispose();
    device.release();
  }
  rows.push({name: 'output-final-lifetime', passed: lifetime.closed});
  const failures = rows.filter((r) => !r.passed);
  return {
    available: true,
    adapter,
    cases: rows.length,
    failed: failures.length,
    failures,
    rows,
    syntheticDataOnly: true,
    screenshots: false,
  };
}

if (process.argv.includes('--help'))
  console.log(
    'Usage: node tools/probe-d3d11-output.mjs [--browser path] [--output new-results.json]',
  );
else
  try {
    const root = new URL('../', import.meta.url),
      paths = [
        'tools/probe-d3d11-output.mjs',
        'tools/lib/synthetic-browser-probe.mjs',
        'dist/graphics/block-texture.js',
        'dist/graphics/dxgi-layout.js',
      ];
    for (const directory of ['src/native/d3d11/', 'dist/native/d3d11/'])
      for (const path of await readdir(new URL(directory, root), {recursive: true}))
        if (/\.(?:ts|js)$/.test(path)) paths.push(directory + path);
    const files = await Promise.all(
      paths.sort().map(async (path) => {
        const absolute = fileURLToPath(new URL(path, root)),
          bytes = await readFile(absolute);
        return {
          path: absolute,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      }),
    );
    const result = await runSyntheticBrowserProbe({
      options: parseSyntheticBrowserOptions(process.argv.slice(2)),
      fixture: {},
      pageMain,
      runtimeRoot: fileURLToPath(new URL('dist/', root)),
      name: 'vn-d3d11-output',
    });
    for (const f of files)
      if (
        createHash('sha256')
          .update(await readFile(f.path))
          .digest('hex') !== f.sha256
      )
        throw Error('Source/dist changed during output probe: ' + f.path);
    await writeFile(
      result.outputPath,
      JSON.stringify(
        {
          ...result,
          files,
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
