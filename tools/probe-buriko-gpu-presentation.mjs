import {fileURLToPath} from 'node:url';
import {
  parseSyntheticBrowserOptions,
  runSyntheticBrowserProbe,
} from './lib/synthetic-browser-probe.mjs';

/**
 * Compares the browser-optimized WebGL presentation with the software reference sampler over
 * generated display textures. `differing` counts pixels of the WebGL output (gl.readPixels) that
 * differ from the reference; `copyDiffering` counts pixels the browser's WebGL-to-2D canvas copy
 * changes afterwards, which is outside the engine's control.
 */
async function pageMain(_fixture, options) {
  options = {samples: 4, ...options};
  const [{BurikoDisplayTexture}, gpu, sampling] = await Promise.all([
    import('/runtime/engines/buriko/native/display-texture.js'),
    import('/runtime/engines/buriko/native/display-gpu-presenter.js'),
    import('/runtime/engines/buriko/native/presentation-sampling.js'),
  ]);
  const f32 = Math.fround;
  const presenter = gpu.BurikoGpuPresenter.create(document);
  if (presenter === null) return {available: false, reason: 'WebGL 2 unavailable'};
  let seed = 0x2545f491;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  function vertices(left, top, right, bottom, u, v) {
    const bytes = new Uint8Array(112),
      view = new DataView(bytes.buffer);
    const corners = [
      [left, top, 0, 0],
      [right, top, u, 0],
      [left, bottom, 0, v],
      [right, bottom, u, v],
    ];
    corners.forEach(([x, y, s, t], index) => {
      view.setFloat32(index * 28, x, true);
      view.setFloat32(index * 28 + 4, y, true);
      view.setFloat32(index * 28 + 12, 1, true);
      view.setFloat32(index * 28 + 20, s, true);
      view.setFloat32(index * 28 + 24, t, true);
    });
    return bytes;
  }
  const size = options.smoke ? 0.25 : 1;
  const scaled = (value) => Math.max(1, Math.round(value * size));
  const cases = [
    ['1:1 1080p linear', 1920, 1080, 2048, 2048, 1920, 1080, 0, 0, 'linear'],
    ['1:1 1080p point', 1920, 1080, 2048, 2048, 1920, 1080, 0, 0, 'point'],
    ['720p to 1080p linear', 1280, 720, 2048, 1024, 1920, 1080, 0, 0, 'linear'],
    ['720p to 1080p point', 1280, 720, 2048, 1024, 1920, 1080, 0, 0, 'point'],
    ['1080p to 800x600 linear', 1920, 1080, 2048, 2048, 800, 600, 0, 75, 'linear'],
    ['shaken 1:1 linear', 1920, 1080, 2048, 2048, 1920, 1080, 7, -5, 'linear'],
  ].map(([name, lw, lh, tw, th, ow, oh, dx, dy, sampler]) => {
    const [logicalWidth, logicalHeight, outputWidth, outputHeight] = [lw, lh, ow, oh].map(scaled);
    const [textureWidth, textureHeight] = [tw, th].map((value) => Math.max(1, value * size));
    return {
      name,
      logicalWidth,
      logicalHeight,
      textureWidth,
      textureHeight,
      outputWidth,
      outputHeight,
      dx,
      dy,
      sampler,
    };
  });
  const results = [];
  const canvas = document.createElement('canvas');
  for (const test of cases) {
    const texture = new BurikoDisplayTexture(test.textureWidth, test.textureHeight, 22);
    const words = new Uint32Array(
      texture.storage.bytes.buffer,
      texture.storage.bytes.byteOffset,
      texture.storage.bytes.byteLength >>> 2,
    );
    for (let y = 0; y < test.logicalHeight; y++)
      for (let x = 0; x < test.logicalWidth; x++) words[y * test.textureWidth + x] = random();
    // Letterboxed quad, like burikoPresentationVertices, with the transient shake offset.
    const scale = Math.min(
      test.outputWidth / test.logicalWidth,
      test.outputHeight / test.logicalHeight,
    );
    const width = Math.round(test.logicalWidth * scale),
      height = Math.round(test.logicalHeight * scale);
    const left = ((test.outputWidth - width) >> 1) + test.dx,
      top = ((test.outputHeight - height) >> 1) + test.dy;
    const quad = vertices(
      f32(f32(left) - 0.5),
      f32(f32(top) - 0.5),
      f32(f32(left + width) - 0.5),
      f32(f32(top + height) - 0.5),
      f32(f32(test.logicalWidth) / f32(test.textureWidth)),
      f32(f32(test.logicalHeight) / f32(test.textureHeight)),
    );
    const coordinates = gpu.burikoGpuQuadCoordinates(
      quad,
      texture.width,
      texture.height,
      test.outputWidth,
      test.outputHeight,
      test.sampler,
    );
    presenter.invalidate();
    const started = performance.now();
    presenter.upload(texture, test.logicalWidth, test.logicalHeight, undefined);
    presenter.draw(texture, coordinates, test.sampler, test.outputWidth, test.outputHeight, true);
    canvas.width = test.outputWidth;
    canvas.height = test.outputHeight;
    const context = canvas.getContext('2d', {alpha: false});
    context.drawImage(presenter.output, 0, 0);
    const copied = context.getImageData(0, 0, test.outputWidth, test.outputHeight).data;
    const elapsed = performance.now() - started;
    // The WebGL output itself, bottom-up rows flipped, isolates the shader from the canvas copy.
    const gl = presenter.output.getContext('webgl2');
    const flipped = new Uint8Array(copied.length),
      actual = new Uint8ClampedArray(copied.length),
      stride = test.outputWidth * 4;
    gl.readPixels(0, 0, test.outputWidth, test.outputHeight, gl.RGBA, gl.UNSIGNED_BYTE, flipped);
    for (let row = 0; row < test.outputHeight; row++)
      actual.set(
        flipped.subarray(
          (test.outputHeight - 1 - row) * stride,
          (test.outputHeight - row) * stride,
        ),
        row * stride,
      );
    let copyDiffering = 0;
    for (let offset = 0; offset < copied.length; offset += 4)
      if (
        copied[offset] !== actual[offset] ||
        copied[offset + 1] !== actual[offset + 1] ||
        copied[offset + 2] !== actual[offset + 2]
      )
        copyDiffering++;
    const view = new DataView(quad.buffer);
    const [qLeft, qTop, qRight, qBottom] = [0, 4, 28, 60].map((o) => view.getFloat32(o, true));
    const uMax = view.getFloat32(48, true),
      vMax = view.getFloat32(80, true);
    const color = [0, 0, 0, 0],
      scratch = {a: [0, 0, 0, 0], b: [0, 0, 0, 0], c: [0, 0, 0, 0], d: [0, 0, 0, 0]};
    const expected = new Uint8ClampedArray(actual.length);
    for (let offset = 3; offset < expected.length; offset += 4) expected[offset] = 255;
    const firstX = Math.max(0, Math.ceil(qLeft)),
      lastX = Math.min(test.outputWidth, Math.ceil(qRight));
    const firstY = Math.max(0, Math.ceil(qTop)),
      lastY = Math.min(test.outputHeight, Math.ceil(qBottom));
    for (let row = firstY; row < lastY; row++) {
      const v = f32(f32(f32(row - qTop) / f32(qBottom - qTop)) * vMax);
      for (let column = firstX; column < lastX; column++) {
        const u = f32(f32(f32(column - qLeft) / f32(qRight - qLeft)) * uMax);
        sampling.burikoPresentationTextureSampleInto(texture, u, v, test.sampler, color, scratch);
        const offset = (row * test.outputWidth + column) * 4;
        expected[offset] = f32(color[0] * 255);
        expected[offset + 1] = f32(color[1] * 255);
        expected[offset + 2] = f32(color[2] * 255);
      }
    }
    let differing = 0,
      maximum = 0;
    const samples = [];
    for (let offset = 0; offset < actual.length; offset += 4) {
      let pixel = 0;
      for (let channel = 0; channel < 4; channel++)
        pixel = Math.max(pixel, Math.abs(actual[offset + channel] - expected[offset + channel]));
      if (pixel !== 0) {
        differing++;
        if (samples.length < options.samples || pixel > maximum) {
          if (samples.length >= options.samples) samples.pop();
          const index = offset >> 2,
            column = index % test.outputWidth,
            row = (index / test.outputWidth) | 0;
          samples.push({
            column,
            row,
            actual: Array.from(actual.subarray(offset, offset + 4)),
            expected: Array.from(expected.subarray(offset, offset + 4)),
            x: Array.from(
              coordinates.columns.subarray(
                (column - coordinates.firstX) * 2,
                (column - coordinates.firstX) * 2 + 2,
              ),
            ),
            y: Array.from(
              coordinates.rows.subarray(
                (row - coordinates.firstY) * 2,
                (row - coordinates.firstY) * 2 + 2,
              ),
            ),
          });
        }
      }
      maximum = Math.max(maximum, pixel);
    }
    results.push({
      name: test.name,
      output: [test.outputWidth, test.outputHeight],
      pixels: actual.length / 4,
      differing,
      maximumDifference: maximum,
      copyDiffering,
      samples,
      milliseconds: Math.round(elapsed * 100) / 100,
    });
    texture.dispose();
  }
  return {available: true, userAgent: navigator.userAgent, results};
}

if (process.argv.includes('--help')) {
  console.log(
    'Usage: node tools/probe-buriko-gpu-presentation.mjs [--browser path] [--output results.json] [--smoke]',
  );
  console.log(
    'Compares WebGL display presentation with the software reference sampler over generated textures. Build dist first with npm run build:runtime.',
  );
} else {
  try {
    await runSyntheticBrowserProbe({
      options: parseSyntheticBrowserOptions(process.argv.slice(2)),
      pageMain,
      runtimeRoot: fileURLToPath(new URL('../dist/', import.meta.url)),
      name: 'vn-gpu-presentation',
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
