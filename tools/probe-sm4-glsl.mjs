import {fileURLToPath} from 'node:url';
import {
  parseSyntheticBrowserOptions,
  runSyntheticBrowserProbe,
} from './lib/synthetic-browser-probe.mjs';
import {sm4SyntheticFixtures, sm4SyntheticPipeline} from './lib/sm4-synthetic-fixtures.mjs';

/** Execute generated SM4 instruction cases on synthetic data; no assets or screenshots. */
async function pageMain(fixture) {
  const {parseSm4Program} = await import('/runtime/graphics/d3d11-shader/bytecode.js');
  const {translateSm4ToGlsl} = await import('/runtime/graphics/d3d11-shader/glsl.js');
  const {D3d11ProgramCache} = await import('/runtime/native/d3d11/webgl2/shaders.js');
  const {createShaderStorage} = await import('/runtime/native/d3d11/runtime/shaders.js');
  const {createBufferStorage} = await import('/runtime/native/d3d11/runtime/resources.js');
  const {D3d11Lifetime, D3d11Object} = await import('/runtime/native/d3d11/runtime/com.js');
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const gl = canvas.getContext('webgl2', {antialias: false, depth: false, stencil: false});
  if (!gl) return {available: false, reason: 'WebGL2 unavailable'};
  const adapter = {
    vendor: gl.getParameter(gl.VENDOR),
    renderer: gl.getParameter(gl.RENDERER),
    version: gl.getParameter(gl.VERSION),
  };
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const framebuffer = gl.createFramebuffer(),
    attachment = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, attachment);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32UI, 1, 1, 0, gl.RGBA_INTEGER, gl.UNSIGNED_INT, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, attachment, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
    throw Error('Integer framebuffer unavailable');
  gl.viewport(0, 0, 1, 1);
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  const version = '#version 300 es\nprecision highp float;\nprecision highp int;\n';
  const vsSource =
    version +
    'void main(){ vec2 p[3]=vec2[3](vec2(-1,-1),vec2(3,-1),vec2(-1,3));gl_Position=vec4(p[gl_VertexID],0,1); }';
  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const error = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw Error(error);
    }
    return shader;
  }
  const vs = compile(gl.VERTEX_SHADER, vsSource),
    rows = [];
  for (const test of fixture.cases) {
    const resources = [],
      gpuSamplers = [];
    let ps = null,
      program = null;
    try {
      const bytecode = new Uint8Array(test.words.length * 4),
        view = new DataView(bytecode.buffer);
      test.words.forEach((n, i) => view.setUint32(i * 4, n, true));
      const translated = translateSm4ToGlsl(parseSm4Program(bytecode));
      const source =
        version +
        translated.source +
        `\nuniform highp uvec4 probe_inputs[${translated.inputRegisters}];\nlayout(location=0) out highp uvec4 result;\nvoid main(){uvec4 outputRegisters[${translated.outputRegisters}]; ${translated.entry}(probe_inputs,outputRegisters);result=outputRegisters[0];}`;
      ps = compile(gl.FRAGMENT_SHADER, source);
      program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, ps);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw Error(gl.getProgramInfoLog(program));
      gl.useProgram(program);
      const active = new Map();
      for (let i = 0; i < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); i++) {
        const info = gl.getActiveUniform(program, i);
        active.set(info.name.replace(/\[0\]$/, ''), info.size);
      }
      function upload(name, words) {
        const size = active.get(name);
        if (size)
          gl.uniform4uiv(gl.getUniformLocation(program, name + '[0]'), words.subarray(0, size * 4));
      }
      const input = new Uint32Array(128);
      test.inputs.forEach((row, i) => input.set(row, i * 4));
      upload('probe_inputs', input);
      for (const buffer of translated.constantBuffers) {
        const words = new Uint32Array(buffer.vectors * 4);
        words.set((test.constants?.[buffer.slot] ?? []).slice(0, words.length));
        upload(buffer.uniform, words);
      }
      const textures = new Map();
      for (let unit = 0; unit < translated.samples.length; unit++) {
        const sample = translated.samples[unit],
          value = test.textures?.[sample.resource];
        if (!value) throw Error('Missing synthetic texture');
        gl.activeTexture(gl.TEXTURE0 + unit);
        let texture = textures.get(sample.resource);
        if (!texture) {
          texture = gl.createTexture();
          textures.set(sample.resource, texture);
          resources.push(texture);
          gl.bindTexture(gl.TEXTURE_2D, texture);
          if (value.bytes)
            gl.texImage2D(
              gl.TEXTURE_2D,
              0,
              gl.RGBA8,
              value.width,
              value.height,
              0,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              new Uint8Array(value.bytes),
            );
          else
            gl.texImage2D(
              gl.TEXTURE_2D,
              0,
              gl.RGBA32F,
              value.width,
              value.height,
              0,
              gl.RGBA,
              gl.FLOAT,
              new Float32Array(value.data),
            );
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        } else gl.bindTexture(gl.TEXTURE_2D, texture);
        const sampler = gl.createSampler();
        gpuSamplers.push(sampler);
        const filter = test.samplers?.[sample.sampler] === 'linear' ? gl.LINEAR : gl.NEAREST;
        gl.samplerParameteri(sampler, gl.TEXTURE_MIN_FILTER, filter);
        gl.samplerParameteri(sampler, gl.TEXTURE_MAG_FILTER, filter);
        gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.samplerParameteri(sampler, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindSampler(unit, sampler);
        gl.uniform1i(gl.getUniformLocation(program, sample.uniform), unit);
      }
      const sentinel = 0xdeadbeef;
      gl.clearBufferuiv(gl.COLOR, 0, new Uint32Array(4).fill(sentinel));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const actual = new Uint32Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, actual);
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw Error('WebGL error ' + error);
      const nan = (word) => (word & 0x7fffffff) > 0x7f800000;
      const order = (word) => (word & 0x80000000 ? ~word >>> 0 : (word ^ 0x80000000) >>> 0);
      const expected = test.discarded ? Array(4).fill(sentinel) : test.expected;
      const matches = [...actual].every((value, i) => {
        if (!test.discarded && test.nanLanes?.includes(i)) return nan(value);
        if (value === expected[i]) return true;
        const magnitude = expected[i] & 0x7fffffff;
        return (
          !test.discarded &&
          test.maxUlp &&
          magnitude > 0 &&
          magnitude < 0x7f800000 &&
          !nan(value) &&
          Math.abs(order(value) - order(expected[i])) <= test.maxUlp
        );
      });
      rows.push({
        name: test.name,
        passed: !!matches,
        actual: [...actual],
        expected,
        constantBuffers: translated.constantBuffers,
        samples: translated.samples,
      });
    } catch (error) {
      rows.push({name: test.name, passed: false, error: error.message});
    } finally {
      for (const resource of resources) gl.deleteTexture(resource);
      for (const sampler of gpuSamplers) gl.deleteSampler(sampler);
      if (program) gl.deleteProgram(program);
      if (ps) gl.deleteShader(ps);
    }
  }
  for (const test of fixture.pipelines) {
    let cache = null,
      device = null,
      vertex = null,
      pixel = null,
      alternative = null,
      buffer = null;
    const nativeBuffers = [];
    try {
      if (!gl.getExtension('EXT_color_buffer_float')) throw Error('Float framebuffer unavailable');
      const lifetime = new D3d11Lifetime(() => cache?.dispose());
      device = new D3d11Object(lifetime, [], () => {}, true);
      const owner = {lifetime, device, resourceDestroyed() {}};
      cache = new D3d11ProgramCache(owner, gl, 1);
      vertex = createShaderStorage(owner, 'vertex', new Uint8Array(test.vertex), null).value;
      pixel = createShaderStorage(owner, 'pixel', new Uint8Array(test.pixel), null).value;
      if (!vertex || !pixel) throw Error('Native synthetic shader creation failed');
      const linked = cache.use(vertex, pixel),
        original = linked.program;
      if (cache.use(vertex, pixel) !== linked) throw Error('Native program reuse failed');
      vertex.release();
      pixel.release();
      function constants(values) {
        const bytes = new Uint8Array(new Float32Array(values).buffer);
        const resource = createBufferStorage(
          owner,
          {
            byteWidth: bytes.length,
            usage: 0,
            bindFlags: 4,
            cpuAccessFlags: 0,
            miscFlags: 0,
            structureByteStride: 0,
          },
          {data: bytes, rowPitch: 0, slicePitch: 0},
        ).value;
        if (!resource) throw Error('Native synthetic constant buffer creation failed');
        nativeBuffers.push(resource);
        return resource;
      }
      const vertexConstants = test.constantBuffers ? [constants([10, 20, 30, 40])] : [];
      const pixelConstants = test.constantBuffers ? [constants([0.125, 0.25, 0, 0])] : [];
      buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(test.attributes), gl.STATIC_DRAW);
      for (const a of linked.attributes) {
        gl.enableVertexAttribArray(a.location);
        gl.vertexAttribPointer(a.location, 4, gl.FLOAT, false, 32, a.register * 16);
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, attachment);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA32F,
        test.width,
        test.height,
        0,
        gl.RGBA,
        gl.FLOAT,
        null,
      );
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
        throw Error('Incomplete float target');
      gl.viewport(0, 0, test.width, test.height);
      function draw(name, vsBuffers, psBuffers, delta, normalizedMask = 0) {
        cache.uploadConstants(linked, vsBuffers, psBuffers);
        cache.uploadOutputRanges(linked, normalizedMask);
        if (linked.targetHeight) gl.uniform1f(linked.targetHeight, test.height);
        gl.clearBufferfv(gl.COLOR, 0, new Float32Array(4).fill(-9));
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        const raw = new Float32Array(test.width * test.height * 4),
          pixels = new Float32Array(raw.length),
          stride = test.width * 4;
        gl.readPixels(0, 0, test.width, test.height, gl.RGBA, gl.FLOAT, raw);
        // The linked shader uses native top-left SV_Position. Raw GL rows start
        // at the bottom; compare the native top-left order used by the fixture.
        for (let y = 0; y < test.height; y++)
          pixels.set(
            raw.subarray((test.height - 1 - y) * stride, (test.height - y) * stride),
            y * stride,
          );
        const error = gl.getError();
        if (error !== gl.NO_ERROR) throw Error('WebGL error ' + error);
        const expected = new Float32Array(
          test.expected.map((n, i) => {
            const value = n + delta[i % 4];
            return normalizedMask & 1 ? Math.max(0, Math.min(1, value)) : value;
          }),
        );
        const actual = new Uint32Array(pixels.buffer),
          words = new Uint32Array(expected.buffer);
        const mismatches = [...actual].flatMap((value, i) =>
          value === words[i] ? [] : [{index: i, actual: value, expected: words[i]}],
        );
        rows.push({
          name,
          passed: mismatches.length === 0,
          values: actual.length,
          mismatches,
          actual: [...actual],
          expected: [...words],
        });
      }
      draw(
        test.name,
        vertexConstants,
        pixelConstants,
        test.constantBuffers ? [0.125, 0.25, 0, 0] : [0, 0, 0, 0],
      );
      if (test.constantBuffers) {
        pixelConstants[0].update(
          0,
          null,
          new Uint8Array(new Float32Array([0.25, 0.5, 0.25, 0]).buffer),
          0,
        );
        draw(test.name + '-updated', vertexConstants, pixelConstants, [0.25, 0.5, 0.25, 0]);
        draw(test.name + '-unbound', [], [], [0, 0, 0, 0]);
      }
      // Reuse one linked pair across different output ranges. Float readback
      // distinguishes shader source clamping from automatic UNORM target stores.
      draw(test.name + '-unorm-range', [], [], [0, 0, 0, 0], 1);
      draw(test.name + '-unchanged-range', [], [], [0, 0, 0, 0], 1);
      draw(test.name + '-other-output-range', [], [], [0, 0, 0, 0], 2);
      draw(test.name + '-float-range-restored', [], [], [0, 0, 0, 0], 0);
      alternative = createShaderStorage(owner, 'pixel', new Uint8Array(test.pixel), null).value;
      const replaced = cache.use(vertex, alternative);
      alternative.release();
      if (gl.isProgram(original) || pixel.live || !vertex.live)
        throw Error('Native cache eviction ownership failed');
      let retiredRejected = false;
      try {
        cache.uploadConstants(linked, [], []);
      } catch {
        retiredRejected = true;
      }
      let retiredRangeRejected = false;
      try {
        cache.uploadOutputRanges(linked, 1);
      } catch {
        retiredRangeRejected = true;
      }
      cache.dispose();
      if (
        gl.isProgram(replaced.program) ||
        vertex.live ||
        alternative.live ||
        !retiredRejected ||
        !retiredRangeRejected
      )
        throw Error('Native cache disposal ownership failed');
      rows.push({
        name: test.name + '-ownership',
        passed: true,
        reused: true,
        evicted: true,
        retiredRejected,
        retiredRangeRejected,
        disposed: true,
      });
    } catch (error) {
      rows.push({name: test.name, passed: false, error: error.message});
    } finally {
      for (let i = 0; i < 2; i++) gl.disableVertexAttribArray(i);
      if (buffer) gl.deleteBuffer(buffer);
      cache?.dispose();
      vertex?.release();
      pixel?.release();
      alternative?.release();
      for (const resource of nativeBuffers) resource.release();
      device?.release();
    }
  }
  gl.deleteShader(vs);
  gl.deleteTexture(attachment);
  gl.deleteFramebuffer(framebuffer);
  gl.deleteVertexArray(vao);
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
  console.log('Usage: node tools/probe-sm4-glsl.mjs [--browser path] [--output new-results.json]');
else
  try {
    const result = await runSyntheticBrowserProbe({
      options: parseSyntheticBrowserOptions(process.argv.slice(2)),
      fixture: {
        cases: sm4SyntheticFixtures(),
        pipelines: [
          [false, false],
          [true, false],
          [false, true],
        ].map(([centroid, constantBuffers]) => {
          const pipeline = sm4SyntheticPipeline(centroid, constantBuffers);
          return {
            ...pipeline,
            vertex: [...pipeline.vertex],
            pixel: [...pipeline.pixel],
            name: constantBuffers
              ? 'native-constant-buffers'
              : centroid
                ? 'packed-centroid-pipeline'
                : 'packed-linear-pipeline',
          };
        }),
      },
      pageMain,
      runtimeRoot: fileURLToPath(new URL('../dist/', import.meta.url)),
      name: 'vn-sm4-glsl',
    });
    console.log(
      JSON.stringify({cases: result.cases, failed: result.failed, failures: result.failures}),
    );
    if (result.failed) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
