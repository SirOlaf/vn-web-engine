import {readFile, readdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {
  parseSyntheticBrowserOptions,
  runSyntheticBrowserProbe,
} from './lib/synthetic-browser-probe.mjs';

/** Numeric synthetic textures only. Every expected byte is computed independently of GPU storage. */
async function pageMain() {
  const {D3d11Lifetime, D3d11Object} = await import('/runtime/native/d3d11/runtime/com.js');
  const {createTexture2DStorage, createBufferStorage} =
    await import('/runtime/native/d3d11/runtime/resources.js');
  const {
    createRenderTargetViewStorage,
    createShaderResourceViewStorage,
    createDepthStencilViewStorage,
  } = await import('/runtime/native/d3d11/runtime/views.js');
  const {D3d11GpuTextures} = await import('/runtime/native/d3d11/webgl2/textures.js');
  const {D3d11TransferContext} = await import('/runtime/native/d3d11/webgl2/transfers.js');
  const canvas = document.createElement('canvas'),
    gl = canvas.getContext('webgl2', {antialias: false});
  if (!gl) return {available: false, reason: 'WebGL2 unavailable'};
  const adapter = {
    vendor: gl.getParameter(gl.VENDOR),
    renderer: gl.getParameter(gl.RENDERER),
    version: gl.getParameter(gl.VERSION),
  };
  const rows = [],
    resources = [],
    views = [];
  let gpu,
    context,
    forbidReadback = false;
  const lifetime = new D3d11Lifetime(() => {
    context?.disposeBindings();
    gpu?.dispose();
  });
  const device = new D3d11Object(lifetime, [], () => {}, true);
  const owner = {
    lifetime,
    device,
    resourceDestroyed: (r) => gpu?.destroy(r),
    synchronizeResource: (r) => {
      if (forbidReadback) throw Error('Transfer attempted CPU synchronization');
      gpu?.synchronize(r);
    },
    resourceReady: (r) => gpu?.ready(r) ?? true,
  };
  gpu = new D3d11GpuTextures(owner, gl);
  context = new D3d11TransferContext(owner, gl, gpu);
  const readPixels = gl.readPixels.bind(gl);
  gl.readPixels = (...args) => {
    if (forbidReadback) throw Error('Transfer attempted GPU readback');
    return readPixels(...args);
  };
  function transfer(action) {
    forbidReadback = true;
    try {
      action();
    } finally {
      forbidReadback = false;
    }
  }
  const bytesPerPixel = (format) => (format === 65 || format === 61 ? 1 : format === 49 ? 2 : 4);
  function nativePixel(format, rgba) {
    return format === 65
      ? [rgba[3]]
      : format === 61
        ? [rgba[0]]
        : format === 49
          ? rgba.slice(0, 2)
          : format === 87
            ? [rgba[2], rgba[1], rgba[0], rgba[3]]
            : rgba;
  }
  function sampled(format, bytes) {
    const result = [];
    for (let i = 0; i < bytes.length; i += bytesPerPixel(format))
      result.push(
        ...(format === 65
          ? [0, 0, 0, bytes[i]]
          : format === 61
            ? [bytes[i], 0, 0, 255]
            : format === 49
              ? [bytes[i], bytes[i + 1], 0, 255]
              : format === 87
                ? [bytes[i + 2], bytes[i + 1], bytes[i], bytes[i + 3]]
                : bytes.slice(i, i + 4)),
      );
    return result;
  }
  const fill = (count, pixel) => Uint8Array.from(Array(count).fill(pixel).flat());
  function texture(format, width = 8, height = 8, mips = 4, initial = null, changes = {}) {
    const result = createTexture2DStorage(
      owner,
      {
        format,
        width,
        height,
        mipLevels: mips,
        arraySize: 1,
        sampleDesc: {count: 1, quality: 0},
        usage: 0,
        bindFlags: format === 40 || format === 45 ? 0x40 : 0x28,
        cpuAccessFlags: 0,
        miscFlags: 0,
        ...changes,
      },
      initial?.map((data, mip) => ({
        data,
        rowPitch: Math.max(1, width >> mip) * bytesPerPixel(format),
        slicePitch: 0,
      })) ?? null,
    );
    if (result.hr !== 0) throw Error('Texture creation failed: ' + result.hr);
    resources.push(result.value);
    return result.value;
  }
  function view(resource, kind, mip = 0, count = resource.getDesc().mipLevels - mip) {
    const format = resource.getDesc().format;
    const result =
      kind === 'srv'
        ? createShaderResourceViewStorage(owner, resource, {
            format,
            viewDimension: 4,
            texture2D: {mostDetailedMip: mip, mipLevels: count},
          })
        : kind === 'rtv'
          ? createRenderTargetViewStorage(owner, resource, {
              format,
              viewDimension: 4,
              texture2D: {mipSlice: mip},
            })
          : createDepthStencilViewStorage(owner, resource, {
              format,
              viewDimension: 3,
              flags: 0,
              texture2D: {mipSlice: mip},
            });
    if (result.hr !== 0) throw Error('View creation failed: ' + result.hr);
    views.push(result.value);
    return result.value;
  }
  const prefix = '#version 300 es\nprecision highp float;precision highp int;\n';
  function program(fragment) {
    const shaders = [
      [
        gl.VERTEX_SHADER,
        prefix +
          'uniform float z;void main(){vec2 p[3]=vec2[3](vec2(-1,-1),vec2(3,-1),vec2(-1,3));gl_Position=vec4(p[gl_VertexID],z,1);}',
      ],
      [gl.FRAGMENT_SHADER, prefix + fragment],
    ].map(([type, source]) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw Error(gl.getShaderInfoLog(shader));
      return shader;
    });
    const result = gl.createProgram();
    for (const shader of shaders) gl.attachShader(result, shader);
    gl.linkProgram(result);
    for (const shader of shaders) gl.deleteShader(shader);
    if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(result));
    return result;
  }
  const sample = program(
    // Alpha-only images use the linked-program view: red storage reads as (0, 0, 0, a).
    'uniform sampler2D image;uniform int mip;uniform bool rawDepth;uniform bool flipY;uniform bool alphaView;layout(location=0)out uvec4 result;void main(){vec4 value=texelFetch(image,ivec2(gl_FragCoord.x,flipY?float(textureSize(image,mip).y)-gl_FragCoord.y:gl_FragCoord.y),mip);if(alphaView)value=vec4(0.0,0.0,0.0,value.r);result=rawDepth?uvec4(floatBitsToUint(value.r)):uvec4(round(value*255.0));}',
  );
  const depthProgram = program('out vec4 result;void main(){result=vec4(1,0,0,1);}');
  const target = gl.createTexture(),
    fbo = gl.createFramebuffer(),
    vao = gl.createVertexArray();
  const hash = async (bytes) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((n) => n.toString(16).padStart(2, '0'))
      .join('');
  async function record(name, actual, expected) {
    const mismatches = [];
    let count = Math.abs(actual.length - expected.length);
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
  function baseline() {
    for (const flag of [
      gl.BLEND,
      gl.CULL_FACE,
      gl.DEPTH_TEST,
      gl.STENCIL_TEST,
      gl.SCISSOR_TEST,
      gl.DITHER,
      gl.RASTERIZER_DISCARD,
    ])
      gl.disable(flag);
    gl.colorMask(true, true, true, true);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.PACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.PACK_SKIP_ROWS, 0);
  }
  function attach(width, height, integer) {
    baseline();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      integer ? gl.RGBA32UI : gl.RGBA8,
      width,
      height,
      0,
      integer ? gl.RGBA_INTEGER : gl.RGBA,
      integer ? gl.UNSIGNED_INT : gl.UNSIGNED_BYTE,
      null,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.TEXTURE_2D, null, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.viewport(0, 0, width, height);
  }
  function checkError() {
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw Error('WebGL error ' + error);
  }
  async function color(name, resource, mip, expected, srv = null, rawDepth = false) {
    const level = resource.levels[mip],
      image = srv ? gpu.shaderResource(srv) : gpu.image(resource);
    attach(level.width, level.height, true);
    gl.useProgram(sample);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, image);
    gl.bindSampler(0, null);
    gl.uniform1i(gl.getUniformLocation(sample, 'image'), 0);
    gl.uniform1i(gl.getUniformLocation(sample, 'mip'), srv ? 0 : mip);
    gl.uniform1i(gl.getUniformLocation(sample, 'rawDepth'), rawDepth ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(sample, 'flipY'), +(!srv && gpu.flipped(resource)));
    gl.uniform1i(gl.getUniformLocation(sample, 'alphaView'), +(resource.getDesc().format === 65));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const actual = new Uint32Array(level.width * level.height * 4);
    gl.readPixels(0, 0, level.width, level.height, gl.RGBA_INTEGER, gl.UNSIGNED_INT, actual);
    checkError();
    await record(
      name,
      actual,
      Uint32Array.from(rawDepth ? expected : sampled(resource.getDesc().format, expected)),
    );
  }
  async function depthWords(name, resource, mip, value) {
    const level = resource.levels[mip],
      word = new Uint32Array(new Float32Array([value]).buffer)[0];
    await color(name, resource, mip, Array(level.width * level.height * 4).fill(word), null, true);
  }
  async function depth(name, resource, mip, stencil, passed, at = 0.5, func = gl.LESS) {
    const level = resource.levels[mip],
      image = gpu.image(resource);
    attach(level.width, level.height, false);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      resource.getDesc().format === 45 ? gl.DEPTH_STENCIL_ATTACHMENT : gl.DEPTH_ATTACHMENT,
      gl.TEXTURE_2D,
      image,
      mip,
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw Error('Incomplete depth target');
    gl.clearBufferfv(gl.COLOR, 0, new Float32Array(4));
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(func);
    gl.depthMask(false);
    if (stencil !== null) {
      gl.enable(gl.STENCIL_TEST);
      gl.stencilFunc(gl.EQUAL, stencil, 255);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      gl.stencilMask(0);
    }
    gl.useProgram(depthProgram);
    gl.uniform1f(gl.getUniformLocation(depthProgram, 'z'), 2 * at - 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const actual = new Uint8Array(level.width * level.height * 4);
    gl.readPixels(0, 0, level.width, level.height, gl.RGBA, gl.UNSIGNED_BYTE, actual);
    checkError();
    await record(
      name,
      actual,
      fill(level.width * level.height, passed ? [255, 0, 0, 255] : [0, 0, 0, 0]),
    );
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.TEXTURE_2D, null, 0);
  }
  try {
    for (const format of [28, 87, 61, 49, 65]) {
      const source = texture(format),
        destination = texture(format),
        alias = view(destination, 'srv', 0, 1);
      gpu.shaderResource(alias);
      const expected = [];
      for (let mip = 0; mip < 4; mip++) {
        const rgba = [32 + mip * 16, 96 + mip * 16, 160 + mip * 16, 224 + mip * 8];
        transfer(() =>
          context.clearRenderTargetView(
            view(source, 'rtv', mip),
            rgba.map((n) => n / 255),
          ),
        );
        expected.push(fill(Math.max(1, 8 >> mip) ** 2, nativePixel(format, rgba)));
      }
      transfer(() => context.clearRenderTargetView(view(destination, 'rtv'), [0, 0, 0, 0]));
      gl.enable(gl.SCISSOR_TEST);
      gl.scissor(0, 0, 0, 0);
      gl.colorMask(false, false, false, false);
      transfer(() =>
        context.copySubresourceRegion(destination, 0, 3, 4, 0, source, 0, {
          left: 1,
          top: 2,
          front: 0,
          right: 4,
          bottom: 4,
          back: 1,
        }),
      );
      const partial = fill(64, nativePixel(format, [0, 0, 0, 0])),
        bpp = bytesPerPixel(format);
      for (let y = 4; y < 6; y++)
        for (let x = 3; x < 6; x++) partial.set(expected[0].subarray(0, bpp), (y * 8 + x) * bpp);
      await color(format + '-region-copy', destination, 0, partial, alias);
      // Opposite physical row origins must preserve native top-left coordinates.
      const bppMixed = bytesPerPixel(format),
        mixedBytes = Uint8Array.from(
          {length: 8 * 8 * bppMixed},
          (_, i) => (Math.floor(i / bppMixed / 8) * 31 + i * 13) & 255,
        ),
        mixedSource = texture(format, 8, 8, 1, [mixedBytes], {bindFlags: 8}),
        mixedTarget = texture(format, 8, 8, 1),
        mixedReturn = texture(format, 8, 8, 1, null, {bindFlags: 8});
      transfer(() => context.copyResource(mixedTarget, mixedSource));
      await color(format + '-source-to-target-origin', mixedTarget, 0, mixedBytes);
      transfer(() => context.copyResource(mixedReturn, mixedTarget));
      await color(format + '-target-to-source-origin', mixedReturn, 0, mixedBytes);
      await record(
        format + '-mixed-origin-native-shadow',
        mixedReturn.storage(0).bytes,
        mixedBytes,
      );
      transfer(() => context.clearRenderTargetView(view(mixedTarget, 'rtv'), [0, 0, 0, 0]));
      transfer(() =>
        context.copySubresourceRegion(mixedTarget, 0, 3, 4, 0, mixedSource, 0, {
          left: 1,
          top: 2,
          front: 0,
          right: 4,
          bottom: 4,
          back: 1,
        }),
      );
      const mixedExpected = fill(64, nativePixel(format, [0, 0, 0, 0]));
      for (let y = 0; y < 2; y++)
        mixedExpected.set(
          mixedBytes.subarray(((y + 2) * 8 + 1) * bppMixed, ((y + 2) * 8 + 4) * bppMixed),
          ((y + 4) * 8 + 3) * bppMixed,
        );
      await color(format + '-mixed-origin-region', mixedTarget, 0, mixedExpected);
      const revision = destination.revision;
      let rejected = false;
      try {
        transfer(() =>
          context.copySubresourceRegion(destination, 0, 7, 7, 0, source, 0, {
            left: 0,
            top: 0,
            front: 0,
            right: 2,
            bottom: 2,
            back: 1,
          }),
        );
      } catch {
        rejected = true;
      }
      rows.push({
        name: format + '-invalid-copy-atomic',
        passed: rejected && revision === destination.revision,
      });
      transfer(() => context.copyResource(destination, source));
      for (let mip = 0; mip < 4; mip++)
        await color(format + '-whole-copy-' + mip, destination, mip, expected[mip]);
      await record(format + '-native-shadow', destination.storage(0).bytes, expected[0]);
      transfer(() =>
        context.copySubresourceRegion(source, 1, 0, 0, 0, source, 0, {
          left: 0,
          top: 0,
          front: 0,
          right: 4,
          bottom: 4,
          back: 1,
        }),
      );
      await color(format + '-same-resource-mips', source, 1, expected[0].subarray(0, 16 * bpp));

      const initial = Array.from({length: 4}, (_, mip) => {
        const size = Math.max(1, 8 >> mip);
        if (mip > 0) return fill(size * size, Array(bpp).fill(100 + mip * 20));
        const data = new Uint8Array(size * size * bpp);
        for (let y = 0; y < size; y++)
          for (let x = 0; x < size; x++)
            for (let c = 0; c < bpp; c++)
              data[(y * size + x) * bpp + c] = (x % 2) * 8 + (y % 2) * 16 + c * 40;
        return data;
      });
      const mipResource = texture(format, 8, 8, 4, initial, {miscFlags: 1}),
        range = view(mipResource, 'srv', 1, 2),
        lower = view(mipResource, 'srv', 2, 1);
      gpu.shaderResource(lower);
      transfer(() => context.generateMips(range));
      for (let mip = 0; mip < 4; mip++)
        await color(
          format + '-range-mips-' + mip,
          mipResource,
          mip,
          mip === 2 ? fill(4, Array(bpp).fill(120)) : initial[mip],
          mip === 2 ? lower : null,
        );
      const full = view(mipResource, 'srv');
      transfer(() => context.generateMips(full));
      await color(format + '-mips-source-preserved', mipResource, 0, initial[0]);
      for (let mip = 1; mip < 4; mip++)
        await color(
          format + '-full-mips-' + mip,
          mipResource,
          mip,
          fill(
            Math.max(1, 8 >> mip) ** 2,
            Array.from({length: bpp}, (_, c) => 12 + c * 40),
          ),
        );
      const old = mipResource.revision;
      transfer(() => context.generateMips(lower));
      rows.push({name: format + '-single-mip-noop', passed: old === mipResource.revision});
      const generated = fill(
        4,
        Array.from({length: bpp}, (_, c) => 12 + c * 40),
      );
      await record(format + '-generated-native-shadow', mipResource.storage(2).bytes, generated);
      context.updateSubresource(
        mipResource,
        0,
        {left: 0, top: 0, front: 0, right: 1, bottom: 1, back: 1},
        new Uint8Array(bpp).fill(88),
        bpp,
        0,
      );
      await color(format + '-generated-mip-survives-cpu-update', mipResource, 2, generated);
      const ordinary = texture(format, 8, 8, 4, initial),
        ordinaryView = view(ordinary, 'srv');
      transfer(() => context.generateMips(ordinaryView));
      await color(format + '-missing-misc-noop', ordinary, 1, initial[1]);
    }
    {
      const source = resources[0],
        staging = texture(28, 8, 8, 4, null, {usage: 3, bindFlags: 0, cpuAccessFlags: 0x20000});
      transfer(() => context.copyResource(staging, source));
      let mapped = context.map(staging, 0, 1, 0x100000),
        attempts = 1;
      const firstHr = mapped.hr;
      while (mapped.hr === (0x887a000a | 0) && attempts < 200) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        mapped = context.map(staging, 0, 1, 0x100000);
        attempts++;
      }
      if (mapped.hr !== 0) throw Error('Nonblocking staging map did not complete: ' + mapped.hr);
      await record('context-staging-map', mapped.value.data, fill(64, [32, 96, 160, 224]));
      rows.push({
        name: 'context-staging-readiness',
        passed: firstHr === (0x887a000a | 0),
        firstHr,
        attempts,
      });
      context.unmap(staging, 0);
    }
    for (const format of [40, 45]) {
      const source = texture(format, 4, 4, 3),
        destination = texture(format, 4, 4, 3);
      for (let mip = 0; mip < 3; mip++) {
        const dsv = view(source, 'dsv', mip);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0, 0, 0, 0);
        gl.depthMask(false);
        gl.stencilMask(0);
        gl.viewport(0, 0, 0, 0);
        transfer(() => context.clearDepthStencilView(dsv, format === 45 ? 3 : 1, 0.75, 0xa5));
        await depth(format + '-clear-both-' + mip, source, mip, format === 45 ? 0xa5 : null, true);
        if (format === 40) await depthWords('40-clear-float32-' + mip, source, mip, 0.75);
        transfer(() => context.clearDepthStencilView(dsv, 1, 0.25, 0));
        await depth(
          format + '-depth-clear-preserves-stencil-' + mip,
          source,
          mip,
          format === 45 ? 0xa5 : null,
          true,
          0.125,
        );
        if (format === 40) await depthWords('40-depth-clear-float32-' + mip, source, mip, 0.25);
        if (format === 45) {
          transfer(() => context.clearDepthStencilView(dsv, 2, 0.9, 0x5a));
          await depth(format + '-stencil-clear-preserves-depth-' + mip, source, mip, 0x5a, false);
          await depth(format + '-stencil-new-value-' + mip, source, mip, 0x5a, true, 0.125);
        }
      }
      transfer(() => context.copyResource(destination, source));
      for (let mip = 0; mip < 3; mip++) {
        if (format === 40) await depthWords('40-copy-float32-' + mip, destination, mip, 0.25);
        await depth(
          format + '-whole-depth-copy-' + mip,
          destination,
          mip,
          format === 45 ? 0x5a : null,
          true,
          0.125,
        );
        await depth(
          format + '-whole-depth-copy-upper-' + mip,
          destination,
          mip,
          format === 45 ? 0x5a : null,
          false,
          0.5,
        );
      }
      const dsv = view(source, 'dsv');
      transfer(() => context.clearDepthStencilView(dsv, 1, 3, 0));
      transfer(() => context.copySubresourceRegion(destination, 0, 0, 0, 0, source, 0, null));
      await depth(
        format + '-depth-copy-clamp-high',
        destination,
        0,
        format === 45 ? 0x5a : null,
        true,
        0.875,
      );
      transfer(() => context.clearDepthStencilView(dsv, 1, -3, 0));
      if (format === 40) {
        await depthWords('40-copy-high-float32', destination, 0, 1);
        await depthWords('40-clear-low-float32', source, 0, 0);
      }
      await depth(
        format + '-depth-clamp-low',
        source,
        0,
        format === 45 ? 0x5a : null,
        true,
        0,
        gl.LEQUAL,
      );
      const old = source.revision;
      transfer(() => context.clearDepthStencilView(dsv, 0, 0.8, 0));
      rows.push({name: format + '-zero-flags-noop', passed: source.revision === old});
    }
    const a = createBufferStorage(
      owner,
      {
        byteWidth: 16,
        usage: 0,
        bindFlags: 1,
        cpuAccessFlags: 0,
        miscFlags: 0,
        structureByteStride: 0,
      },
      {data: Uint8Array.from({length: 16}, (_, i) => i), rowPitch: 0, slicePitch: 0},
    ).value;
    const b = createBufferStorage(
      owner,
      {
        byteWidth: 16,
        usage: 3,
        bindFlags: 0,
        cpuAccessFlags: 0x20000,
        miscFlags: 0,
        structureByteStride: 0,
      },
      null,
    ).value;
    resources.push(a, b);
    context.copyResource(b, a);
    const mapped = context.map(b, 0, 1, 0);
    await record(
      'context-buffer-copy-map',
      mapped.value.data,
      Uint8Array.from({length: 16}, (_, i) => i),
    );
    context.unmap(b, 0);
    context.updateSubresource(
      a,
      0,
      {left: 3, top: 0, front: 0, right: 5, bottom: 1, back: 1},
      new Uint8Array([99, 88]),
      0,
      0,
    );
    const want = Uint8Array.from({length: 16}, (_, i) => i);
    want.set([99, 88], 3);
    await record('context-buffer-update', a.storage(0).bytes, want);
    let rejected = false;
    try {
      context.copyResource(a, a);
    } catch {
      rejected = true;
    }
    rows.push({name: 'context-self-copy-rejected', passed: rejected});
    context.flush();
    const extension = gl.getExtension('WEBGL_lose_context');
    if (!extension) throw Error('Context-loss extension unavailable');
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('Context-loss event timed out')), 2000);
      canvas.addEventListener(
        'webglcontextlost',
        (event) => {
          event.preventDefault();
          clearTimeout(timeout);
          resolve();
        },
        {once: true},
      );
      extension.loseContext();
    });
    const removed = context.map(b, 0, 1, 0);
    rows.push({
      name: 'context-map-device-removed',
      passed: removed.hr === (0x887a0005 | 0) && removed.value === null,
      hr: removed.hr,
    });
  } catch (error) {
    rows.push({name: 'exception', passed: false, error: error.stack});
  } finally {
    gl.useProgram(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteProgram(sample);
    gl.deleteProgram(depthProgram);
    gl.deleteTexture(target);
    gl.deleteFramebuffer(fbo);
    gl.deleteVertexArray(vao);
    for (const value of views) value.release();
    for (const value of resources) value.release();
    context.release();
    device.release();
  }
  rows.push({name: 'final-device-lifetime', passed: lifetime.closed && !context.live});
  const failures = rows.filter((row) => !row.passed);
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
    'Usage: node tools/probe-d3d11-transfers.mjs [--browser path] [--output new-results.json]',
  );
else
  try {
    const options = parseSyntheticBrowserOptions(process.argv.slice(2));
    const root = new URL('../', import.meta.url);
    const paths = [
      'tools/probe-d3d11-transfers.mjs',
      'tools/lib/synthetic-browser-probe.mjs',
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
      options,
      fixture: {},
      pageMain,
      runtimeRoot: fileURLToPath(new URL('dist/', root)),
      name: 'vn-d3d11-transfers',
    });
    for (const file of files)
      if (
        createHash('sha256')
          .update(await readFile(file.path))
          .digest('hex') !== file.sha256
      )
        throw Error('Source/dist changed during GPU probe: ' + file.path);
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
    if (result.failed) process.exitCode = 1;
  } catch (error) {
    console.error(error.stack);
    process.exitCode = 1;
  }
