import {
  parseSyntheticBrowserOptions,
  runSyntheticBrowserProbe,
} from './lib/synthetic-browser-probe.mjs';

async function syntheticCases() {
  let bitmap, compositorModule, affine;
  try {
    [bitmap, compositorModule, affine] = await Promise.all([
      import('../dist/engines/buriko/native/bitmap.js'),
      import('../dist/engines/buriko/native/bitmap-compositor.js'),
      import('../dist/engines/buriko/native/bitmap-affine.js'),
    ]);
  } catch (error) {
    throw new Error('Runtime imports failed; run npm run build:runtime first. ' + error.message);
  }
  const {BurikoBitmapStorage} = bitmap;
  const {BurikoBitmapCompositor} = compositorModule;
  const {burikoBitmapAffineCoordinates, blendTransformedBurikoBitmap} = affine;
  let seed = 0x934cf219;
  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  }
  const compositor = new BurikoBitmapCompositor();
  const identity = {x: 1, y: 0, pivotX: 0, pivotY: 0, angle: 0, scaleX: 65536, scaleY: 65536};
  const cases = [];
  for (let index = 0; index < 96; index++) {
    const sw = 17 + (random() % 20),
      sh = 11 + (random() % 13);
    const width = 13 + (random() % 28),
      height = 7 + (random() % 19);
    const sourceLength = sw * sh * 4,
      destinationLength = width * height * 4;
    const buffer = new Uint8Array(sourceLength + destinationLength);
    const words = new Uint32Array(buffer.buffer);
    for (let i = 0; i < words.length; i++) words[i] = random();
    for (let i = 0; i < sw * sh; i += 13)
      words[i] = (words[i] & 0xffffff) | ([0, 1, 2, 253, 254, 255][((i / 13) % 6) | 0] << 24);
    const storage = new BurikoBitmapStorage(buffer, true);
    const source = {
      storage,
      offset: 0,
      stride: sw * 4,
      width: sw,
      height: sh,
      format: 2,
      bytesPerPixel: 4,
    };
    const destination = {
      storage,
      offset: sourceLength,
      stride: width * 4,
      width,
      height,
      format: 1,
      bytesPerPixel: 4,
    };
    let transform = {
      ...identity,
      x: ((random() % (10 * 65536)) - 5 * 65536) | 1,
      y: (random() % (10 * 65536)) - 5 * 65536,
      angle: ((random() % 31) - 15) * 65536,
      scaleX: 32768 + (random() % 98304),
      scaleY: 32768 + (random() % 98304),
    };
    if (index % 12 === 0) transform = {...identity, x: 0x7fff8001, y: -0x7fff7fff};
    if (index % 12 === 1) transform = {...identity, scaleX: 1, scaleY: 1};
    if (index % 12 === 2) transform = {...identity, x: 0x8001, y: 0x8fff};
    if (index % 12 === 3) transform = {...identity, x: -0x8fff, y: -0x7001};
    if (index % 12 === 4) transform = {...identity, angle: 90 * 65536, pivotX: (sw - 1) * 65536};
    const initial = Array.from(words.subarray(sw * sh));
    const sourcePixels = Array.from(words.subarray(0, sw * sh));
    const transparency = [0, 1, 7, 63, 127, 128, 191, 255][index % 8];
    const bilinear = (index >>> 3) & 1;
    const coordinates = burikoBitmapAffineCoordinates(transform, compositor.revision);
    const layers = index % 12 === 5 ? 3 : 1;
    for (let layer = 0; layer < layers; layer++)
      blendTransformedBurikoBitmap(
        compositor,
        destination,
        source,
        transform,
        transparency,
        bilinear,
      );
    cases.push({
      sw,
      sh,
      width,
      height,
      layers,
      source: sourcePixels,
      initial,
      expected: Array.from(words.subarray(sw * sh)),
      coordinates,
      transparency,
      bilinear,
    });
  }
  const performanceCoordinates = burikoBitmapAffineCoordinates(
    {...identity, x: -0x4000, y: 0x7000, angle: 2 * 65536, scaleX: 68000, scaleY: 68000},
    compositor.revision,
  );

  return {cases, coordinates: performanceCoordinates};
}

/**
 * Bounded initialized, nonalias RGBA-to-RGB only. Integer texture fetches implement
 * Q16 wrapping, Q4 horizontal/vertical floors, Q7 opacity, and preserved output alpha.
 * Native aliases, faults, strip transform setup, and scene ordering remain outside this probe.
 */
async function pageMain({cases, coordinates}, options) {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', {
    alpha: false,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) return {available: false, reason: 'WebGL2 unavailable', userAgent: navigator.userAgent};
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const adapter = {
    vendor: gl.getParameter(gl.VENDOR),
    renderer: gl.getParameter(gl.RENDERER),
    version: gl.getParameter(gl.VERSION),
    unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
    unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null,
    webgpuAvailable: Boolean(navigator.gpu),
    userAgent: navigator.userAgent,
  };
  if (navigator.gpu) {
    try {
      const a = await Promise.race([
        navigator.gpu.requestAdapter(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('WebGPU adapter probe timed out')), 3000),
        ),
      ]);
      adapter.webgpuAdapter = a
        ? {
            ...a.info.toJSON?.(),
            vendor: a.info.vendor,
            architecture: a.info.architecture,
            device: a.info.device,
            description: a.info.description,
          }
        : null;
    } catch (e) {
      adapter.webgpuError = String(e);
    }
  }
  function shader(type, text) {
    const s = gl.createShader(type);
    gl.shaderSource(s, text);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  const vertex = shader(
    gl.VERTEX_SHADER,
    `#version 300 es
  void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`,
  );
  const fragment = shader(
    gl.FRAGMENT_SHADER,
    `#version 300 es
  precision highp float;
  precision highp int;
  precision highp usampler2D;
  uniform usampler2D sourcePixels;
  uniform usampler2D oldDestination;
  uniform ivec2 sourceSize;
  uniform uvec2 start;
  uniform uvec2 columnStep;
  uniform uvec2 rowStep;
  uniform uint transparency;
  uniform int bilinear;
  layout(location=0) out uvec4 result;
  uvec4 sourceAt(ivec2 p) {
    if (any(lessThan(p, ivec2(0))) || any(greaterThanEqual(p, sourceSize))) return uvec4(0);
    return texelFetch(sourcePixels, p, 0);
  }
  uvec4 interpolateQ4(uvec4 a, uvec4 b, uint fraction) { return (a * (16u - fraction) + b * fraction) >> 4u; }
  void main() {
    ivec2 position = ivec2(gl_FragCoord.xy);
    uvec2 fixedPosition = start + uint(position.x) * columnStep + uint(position.y) * rowStep;
    uvec4 source;
    if (bilinear == 0) source = sourceAt(ivec2(fixedPosition + uvec2(32768u)) >> 16);
    else {
      ivec2 p = ivec2(fixedPosition) >> 16;
      uvec2 fraction = (fixedPosition >> 12u) & 15u;
      uvec4 upper = interpolateQ4(sourceAt(p), sourceAt(p + ivec2(1, 0)), fraction.x);
      uvec4 lower = interpolateQ4(sourceAt(p + ivec2(0, 1)), sourceAt(p + ivec2(1, 1)), fraction.x);
      source = interpolateQ4(upper, lower, fraction.y);
    }
    uint index = source.a >> 1u;
    uint coefficient = ((index == 127u ? 128u : index) * (256u - transparency)) >> 8u;
    uvec4 old = texelFetch(oldDestination, position, 0);
    result = uvec4((source.rgb * coefficient + old.rgb * (128u - coefficient)) >> 7u, old.a);
  }`,
  );
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  gl.bindVertexArray(gl.createVertexArray());
  gl.disable(gl.BLEND);
  gl.disable(gl.DITHER);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.enable(gl.SCISSOR_TEST);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
  const uniform = Object.fromEntries(
    [
      'sourcePixels',
      'oldDestination',
      'sourceSize',
      'start',
      'columnStep',
      'rowStep',
      'transparency',
      'bilinear',
    ].map((n) => [n, gl.getUniformLocation(program, n)]),
  );
  gl.uniform1i(uniform.sourcePixels, 0);
  gl.uniform1i(uniform.oldDestination, 1);
  function texture(width, height) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8UI, width, height);
    return t;
  }
  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  function attach(t) {
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error('Integer framebuffer incomplete');
  }
  function setCoordinates(c, sw, sh, bilinear, transparency) {
    gl.uniform2i(uniform.sourceSize, sw, sh);
    gl.uniform2ui(uniform.start, c.startX >>> 0, c.startY >>> 0);
    gl.uniform2ui(uniform.columnStep, c.columnX >>> 0, c.columnY >>> 0);
    gl.uniform2ui(uniform.rowStep, c.rowX >>> 0, c.rowY >>> 0);
    gl.uniform1i(uniform.bilinear, bilinear);
    gl.uniform1ui(uniform.transparency, transparency);
  }
  function bind(unit, t) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
  }
  function upload(t, data, width, height, x = 0, y = 0, w = width, h = height) {
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, width);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, data);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
  }
  function read(x, y, width, height, output) {
    gl.readPixels(x, y, width, height, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, output);
  }
  let parityPixels = 0;
  for (const c of cases) {
    const source = texture(c.sw, c.sh),
      old = texture(c.width, c.height),
      out = texture(c.width, c.height);
    upload(source, new Uint8Array(new Uint32Array(c.source).buffer), c.sw, c.sh);
    upload(old, new Uint8Array(new Uint32Array(c.initial).buffer), c.width, c.height);
    bind(0, source);
    setCoordinates(c.coordinates, c.sw, c.sh, c.bilinear, c.transparency);
    gl.viewport(0, 0, c.width, c.height);
    gl.scissor(0, 0, c.width, c.height);
    let input = old,
      outputTexture = out;
    for (let layer = 0; layer < c.layers; layer++) {
      bind(1, input);
      attach(outputTexture);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      [input, outputTexture] = [outputTexture, input];
    }
    const output = new Uint8Array(c.width * c.height * 4);
    read(0, 0, c.width, c.height, output);
    const words = new Uint32Array(output.buffer);
    for (let i = 0; i < words.length; i++)
      if (words[i] !== c.expected[i])
        throw new Error(
          `Parity failed: case ${cases.indexOf(c)}, pixel ${i}, actual ${words[i].toString(16)}, expected ${c.expected[i].toString(16)}`,
        );
    parityPixels += words.length;
    gl.deleteTexture(source);
    gl.deleteTexture(old);
    gl.deleteTexture(out);
  }
  if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL error after correctness checks');
  const width = options.smoke ? 256 : 1920,
    height = options.smoke ? 144 : 1080,
    bytes = width * height * 4;
  const sourceData = new Uint8Array(bytes),
    oldData = new Uint8Array(bytes),
    readback = new Uint8Array(bytes);
  let state = 0x1823f731;
  for (let i = 0; i < bytes; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    sourceData[i] = state >>> 24;
    oldData[i] = state >>> 16;
  }
  const source = texture(width, height),
    old = texture(width, height),
    out = texture(width, height);
  upload(source, sourceData, width, height);
  upload(old, oldData, width, height);
  upload(out, oldData, width, height);
  gl.viewport(0, 0, width, height);
  function sourceRoi(y, h, bilinear) {
    const xs = [],
      ys = [];
    for (const yy of [y, y + h - 1])
      for (const xx of [0, width - 1]) {
        const fx =
          (coordinates.startX +
            Math.imul(xx, coordinates.columnX) +
            Math.imul(yy, coordinates.rowX)) |
          0;
        const fy =
          (coordinates.startY +
            Math.imul(xx, coordinates.columnY) +
            Math.imul(yy, coordinates.rowY)) |
          0;
        xs.push((bilinear ? fx : (fx + 32768) | 0) >> 16);
        ys.push((bilinear ? fy : (fy + 32768) | 0) >> 16);
      }
    const x = Math.max(0, Math.min(...xs)),
      top = Math.max(0, Math.min(...ys));
    const right = Math.min(width, Math.max(...xs) + 1 + bilinear),
      bottom = Math.min(height, Math.max(...ys) + 1 + bilinear);
    return {x, y: top, w: Math.max(0, right - x), h: Math.max(0, bottom - top)};
  }
  function measure({strips, readEach, uploadEach, layers = 1, bilinear}) {
    gl.finish();
    let uploadSubmitMs = 0,
      drawSubmitMs = 0,
      readbackMs = 0,
      uploadedBytes = 0,
      readbackBytes = 0;
    const totalStart = performance.now();
    let t = performance.now();
    if (!uploadEach) {
      bind(0, source);
      upload(source, sourceData, width, height);
      bind(1, old);
      upload(old, oldData, width, height);
      uploadedBytes += 2 * bytes;
    }
    uploadSubmitMs += performance.now() - t;
    setCoordinates(coordinates, width, height, bilinear, 31);
    let input = old,
      output = out;
    for (let layer = 0; layer < layers; layer++) {
      bind(0, source);
      bind(1, input);
      attach(output);
      for (let strip = 0; strip < strips; strip++) {
        const y = Math.floor((strip * height) / strips),
          end = Math.floor(((strip + 1) * height) / strips),
          h = end - y;
        if (uploadEach) {
          const roi = sourceRoi(y, h, bilinear);
          t = performance.now();
          bind(0, source);
          if (roi.w && roi.h) upload(source, sourceData, width, height, roi.x, roi.y, roi.w, roi.h);
          bind(1, input);
          upload(input, oldData, width, height, 0, y, width, h);
          uploadedBytes += roi.w * roi.h * 4 + width * h * 4;
          uploadSubmitMs += performance.now() - t;
        }
        t = performance.now();
        gl.scissor(0, y, width, h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        drawSubmitMs += performance.now() - t;
        if (readEach) {
          t = performance.now();
          read(0, y, width, h, readback.subarray(y * width * 4, end * width * 4));
          readbackMs += performance.now() - t;
          readbackBytes += width * h * 4;
        }
      }
      [input, output] = [output, input];
    }
    if (!readEach) {
      t = performance.now();
      read(0, 0, width, height, readback);
      readbackMs += performance.now() - t;
      readbackBytes += bytes;
    }
    const totalMs = performance.now() - totalStart;
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error('WebGL error ' + error);
    return {totalMs, uploadSubmitMs, drawSubmitMs, readbackMs, uploadedBytes, readbackBytes};
  }
  const results = [];
  const modes = [
    {name: 'whole-frame', strips: 1, readEach: false, uploadEach: false},
    {name: '120-strips-final-read', strips: 120, readEach: false, uploadEach: false},
    {name: '360-strips-final-read', strips: 360, readEach: false, uploadEach: false},
    {name: '120-strips-each-read', strips: 120, readEach: true, uploadEach: false},
    {name: '360-strips-each-read', strips: 360, readEach: true, uploadEach: false},
    {name: '120-strips-each-roi-upload-read', strips: 120, readEach: true, uploadEach: true},
    {name: '360-strips-each-roi-upload-read', strips: 360, readEach: true, uploadEach: true},
    {
      name: '8-layers-120-strips-final-read',
      strips: 120,
      readEach: false,
      uploadEach: false,
      layers: 8,
    },
  ];
  let wholeFrameReference;
  let stripParityComparisons = 0;
  for (const bilinear of [0, 1])
    for (const mode of modes.filter((mode) => !options.smoke || mode.strips <= 120)) {
      measure({...mode, bilinear});
      // Validate completed output outside measurement, including the ROI upload/readback paths.
      if (mode.name === 'whole-frame') wholeFrameReference = readback.slice();
      else if ((mode.layers ?? 1) === 1) {
        for (let i = 0; i < readback.length; i++)
          if (readback[i] !== wholeFrameReference[i])
            throw new Error(`${mode.name} differs at byte ${i}, sampler ${bilinear}`);
        stripParityComparisons++;
      }
      const samples = [];
      for (let run = 0; run < options.iterations; run++) {
        await new Promise((r) => setTimeout(r, 15));
        samples.push(measure({...mode, bilinear}));
      }
      const median = (key) =>
        samples.map((s) => s[key]).sort((a, b) => a - b)[Math.floor(samples.length / 2)];
      const result = {
        name: mode.name,
        bilinear,
        strips: mode.strips,
        layers: mode.layers ?? 1,
        ...Object.fromEntries(Object.keys(samples[0]).map((k) => [k, median(k)])),
        samples,
      };
      results.push(result);
      await fetch('/progress', {
        method: 'POST',
        body: JSON.stringify({...result, samples: undefined}),
      });
    }
  return {
    available: true,
    adapter,
    parity: {
      cases: cases.length,
      pixels: parityPixels,
      draws: cases.reduce((sum, c) => sum + c.layers, 0),
      repeatedLayerCases: cases.filter((c) => c.layers > 1).length,
      stripParityComparisons,
      reference:
        'production scalar affine-alpha via disjoint ranges of shared backing; RGB destination alpha preserved',
    },
    width,
    height,
    coordinates,
    warmupsPerMode: 1,
    measuredRunsPerMode: options.iterations,
    results,
    notes: [
      'No assets, game URL, screenshots, CPU profiler, or forced software renderer.',
      'Method times are CPU wall time; readback includes pending GPU work. Total includes input upload and synchronous result readback.',
      'Shader and texture setup, source generation, fixture/reference creation, typed-array staging allocation, correctness comparisons, and the initial finish are outside timing. CPU result readback is included.',
      'Resident batches upload source + old destination once; 8-layer case ping-pongs output and reads back once. Per-strip ROI uploads repeat shared source rows needed by the rotated mapping.',
      "Benchmark strips scissor one global Q16 coordinate field. Actual native batching must preserve each strip's independent transform setup and command order.",
      'This tests bounded initialized nonalias RGBA-to-RGB composition, not overlapping storage, unwritten/fault behavior, raster-text metadata, or full native scene equivalence.',
    ],
  };
}

if (process.argv.includes('--help')) {
  console.log(
    'Usage: node tools/benchmark-buriko-webgl.mjs [--browser /path/to/browser] [--output /path/to/results.json] [--iterations 3] [--smoke]',
  );
  console.log(
    'Runs generated numeric affine-alpha parity and 1080p upload/draw/readback measurements in an isolated headless Chromium profile. Build dist first with npm run build:runtime.',
  );
  console.log(
    'Browser: --browser, BROWSER, CHROME_BIN, then installed Brave/Chrome/Chromium. --smoke uses 256×144, fewer strip modes, and one measured run. No game URL, assets, screenshots, or forced software renderer.',
  );
  console.log(
    'Results and browser logs default to a retained temporary directory. Existing --output files are rejected.',
  );
} else {
  try {
    await runSyntheticBrowserProbe({
      options: parseSyntheticBrowserOptions(process.argv.slice(2)),
      fixture: await syntheticCases(),
      pageMain,
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
