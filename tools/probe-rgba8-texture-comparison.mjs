/** Synthetic positive/negative controls for exact GPU comparison and batched readback. */
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {
  runSyntheticBrowserProbe,
  parseSyntheticBrowserOptions,
} from './lib/synthetic-browser-probe.mjs';
if (process.argv.includes('--help')) {
  console.log(
    'Usage: node tools/probe-rgba8-texture-comparison.mjs [--browser path] [--output new-report.json] [--smoke]',
  );
  process.exit(0);
}
const options = parseSyntheticBrowserOptions(process.argv.slice(2));
const module = new URL('./lib/rgba8-texture-comparison.mjs', import.meta.url);
const sha = (b) => createHash('sha256').update(b).digest('hex');
const record = (p) => {
  const b = readFileSync(p);
  return {path: p instanceof URL ? p.pathname : p, bytes: b.length, sha256: sha(b)};
};
const sources = [
  record(module),
  record(new URL(import.meta.url)),
  record(new URL('./lib/synthetic-browser-probe.mjs', import.meta.url)),
];

async function pageMain() {
  const {Rgba8TextureComparison} = await import('/rgba8-texture-comparison.mjs');
  const gl = document.createElement('canvas').getContext('webgl2', {antialias: false});
  if (!gl) return {available: false};
  let reads = 0,
    readbackBytes = 0;
  const read = gl.readPixels.bind(gl);
  gl.readPixels = (x, y, w, h, format, type, data) => {
    if (format !== gl.RGBA_INTEGER || type !== gl.UNSIGNED_INT || h !== 1)
      throw Error('Unexpected diagnostic readback');
    reads++;
    readbackBytes += w * h * 16;
    return read(x, y, w, h, format, type, data);
  };
  const comparator = new Rgba8TextureComparison(gl, 13),
    textures = [],
    results = [],
    expected = new Map(),
    failures = [];
  const polygon = gl.getExtension('WEBGL_polygon_mode');
  const sampler = gl.createSampler(),
    pbo = gl.createBuffer();
  let cases = 0,
    logicalBytesCompared = 0;
  const make = () => {
    const t = gl.createTexture();
    if (!t) throw Error('Synthetic texture allocation failed');
    textures.push(t);
    return t;
  };
  const upload = (texture, w, h, bytes) => {
    gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  };
  const physical = (bytes, w, h, flip) => {
    if (!flip) return bytes.slice();
    const b = new Uint8Array(bytes.length);
    for (let y = 0; y < h; y++)
      b.set(bytes.subarray(y * w * 4, (y + 1) * w * 4), (h - 1 - y) * w * 4);
    return b;
  };
  const oracle = (left, right, w, h, flipLeft, flipRight) => {
    const channels = [0, 0, 0, 0];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w * 4; x++)
        if (
          left[(flipLeft ? h - 1 - y : y) * w * 4 + x] !==
          right[(flipRight ? h - 1 - y : y) * w * 4 + x]
        )
          channels[x % 4] = 1;
    return channels;
  };
  const left = make(),
    right = make();
  const poison = () => {
    for (const capability of [
      gl.BLEND,
      gl.CULL_FACE,
      gl.DEPTH_TEST,
      gl.STENCIL_TEST,
      gl.SCISSOR_TEST,
      gl.RASTERIZER_DISCARD,
      gl.SAMPLE_ALPHA_TO_COVERAGE,
      gl.SAMPLE_COVERAGE,
    ])
      gl.enable(capability);
    gl.colorMask(false, false, false, false);
    gl.scissor(0, 0, 0, 0);
    gl.cullFace(gl.FRONT_AND_BACK);
    gl.depthFunc(gl.NEVER);
    gl.stencilFunc(gl.NEVER, 0, 255);
    gl.sampleCoverage(0, false);
    polygon?.polygonModeWEBGL(gl.FRONT_AND_BACK, polygon.LINE_WEBGL);
    gl.bindSampler(0, sampler);
    gl.bindSampler(1, sampler);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, 1024, gl.STREAM_READ);
    gl.pixelStorei(gl.PACK_ROW_LENGTH, 17);
    gl.pixelStorei(gl.PACK_SKIP_ROWS, 2);
    gl.pixelStorei(gl.PACK_SKIP_PIXELS, 3);
  };
  try {
    for (const [w, h] of [
      [1, 1],
      [15, 17],
      [16, 16],
      [17, 19],
      [33, 31],
      [129, 67],
      [1920, 1080],
    ]) {
      const base = Uint8Array.from(
        {length: w * h * 4},
        (_, i) =>
          ((i % 4) * 79 + (Math.floor(i / 4) % w) * 13 + Math.floor(i / (w * 4)) * 31) & 255,
      );
      for (const flipLeft of [false, true])
        for (const flipRight of [false, true]) {
          const a = physical(base, w, h, flipLeft);
          upload(left, w, h, a);
          const submit = (name, logical) => {
            const b = physical(logical, w, h, flipRight);
            upload(right, w, h, b);
            const label = String(cases++),
              channels = oracle(a, b, w, h, flipLeft, flipRight);
            expected.set(label, {name, w, h, flipLeft, flipRight, channels});
            logicalBytesCompared += w * h * 4;
            poison();
            results.push(
              ...comparator.enqueue(left, right, w, h, label, {
                flipExpected: flipLeft,
                flipActual: flipRight,
              }),
            );
          };
          submit('identical', base);
          const positions = [
            [0, 0],
            [w - 1, 0],
            [0, h - 1],
            [w - 1, h - 1],
            [Math.floor(w / 2), Math.floor(h / 2)],
          ];
          for (const [x, y] of positions)
            for (let channel = 0; channel < 4; channel++) {
              const changed = base.slice();
              changed[(y * w + x) * 4 + channel] ^= 1;
              submit('one-bit-' + x + '-' + y + '-' + channel, changed);
            }
          const changed = base.slice();
          for (let c = 0; c < 4; c++) changed[c] ^= 255;
          submit('four-channels', changed);
        }
    }
    // Every adjacent UNORM8 pair, in every channel, must remain distinguishable.
    for (let channel = 0; channel < 4; channel++)
      for (let value = 0; value < 256; value++) {
        const a = Uint8Array.of(0, 0, 0, 0),
          b = a.slice();
        a[channel] = value;
        b[channel] = (value + 1) & 255;
        upload(left, 1, 1, a);
        upload(right, 1, 1, b);
        const label = String(cases++),
          channels = oracle(a, b, 1, 1, false, false);
        expected.set(label, {
          name: 'adjacent-' + channel + '-' + value,
          w: 1,
          h: 1,
          flipLeft: false,
          flipRight: false,
          channels,
        });
        logicalBytesCompared += 4;
        poison();
        results.push(...comparator.enqueue(left, right, 1, 1, label));
      }
    results.push(...comparator.flush());
    if (results.length !== cases) throw Error('Lost comparison results');
    for (const row of results) {
      const e = expected.get(row.label);
      if (
        JSON.stringify(row.channels) !== JSON.stringify(e.channels) ||
        row.equal !== e.channels.every((v) => v === 0)
      )
        failures.push({expected: e, actual: row});
    }
    const foreignGl = document.createElement('canvas').getContext('webgl2');
    if (!foreignGl) throw Error('Foreign-context control unavailable');
    const foreign = foreignGl.createTexture();
    if (!foreign) throw Error('Foreign texture allocation failed');
    let refused = false;
    try {
      comparator.enqueue(foreign, right, 1, 1, 'foreign');
    } catch (error) {
      refused = /another context/.test(error.message);
    } finally {
      foreignGl.deleteTexture(foreign);
    }
    if (!refused) throw Error('Foreign texture was accepted');
    // Report draw errors before returning, even if a caller drains GL errors before flush.
    const drawArrays = gl.drawArrays.bind(gl);
    let drawRefused = false;
    gl.drawArrays = (...args) => drawArrays(-1, args[1], args[2]);
    try {
      comparator.enqueue(left, right, 1, 1, 'failed-draw');
    } catch (error) {
      drawRefused = /GL error/.test(error.message);
    } finally {
      gl.drawArrays = drawArrays;
      gl.getError();
    }
    if (!drawRefused) throw Error('A failed GPU draw was accepted');
    if (comparator.flush().length) throw Error('Failed draw left a comparison result');
    // A partial reduction-chain allocation must not leave a usable incomplete chain.
    const resizeLeft = new Uint8Array(33 * 31 * 4),
      resizeRight = resizeLeft.slice();
    resizeRight[resizeRight.length - 1] = 1;
    upload(left, 33, 31, resizeLeft);
    upload(right, 33, 31, resizeRight);
    const createFramebuffer = gl.createFramebuffer.bind(gl);
    let allocations = 0,
      allocationRefused = false;
    gl.createFramebuffer = () => (++allocations === 2 ? null : createFramebuffer());
    try {
      comparator.enqueue(left, right, 33, 31, 'failed-resize');
    } catch (error) {
      allocationRefused = /allocation failed/.test(error.message);
    } finally {
      gl.createFramebuffer = createFramebuffer;
    }
    if (!allocationRefused) throw Error('Partial allocation failure was not reported');
    const recoveryLabel = String(cases++);
    expected.set(recoveryLabel, {name: 'resize-recovery', w: 33, h: 31, channels: [0, 0, 0, 1]});
    logicalBytesCompared += 33 * 31 * 4;
    results.push(...comparator.enqueue(left, right, 33, 31, recoveryLabel));
    results.push(...comparator.flush());
    const recovered = results.at(-1);
    if (recovered.equal || JSON.stringify(recovered.channels) !== '[0,0,0,1]')
      throw Error('Incomplete reduction chain concealed a difference after recovery');
    upload(left, 1, 1, Uint8Array.of(1, 2, 3, 4));
    upload(right, 1, 1, Uint8Array.of(1, 2, 3, 5));
    const pendingLabel = String(cases++);
    expected.set(pendingLabel, {name: 'dispose-pending', w: 1, h: 1, channels: [0, 0, 0, 1]});
    logicalBytesCompared += 4;
    poison();
    results.push(...comparator.enqueue(left, right, 1, 1, pendingLabel));
    results.push(...comparator.dispose());
    if (comparator.dispose().length) throw Error('Non-idempotent disposal');
    if (results.length !== cases) throw Error('Lost pending disposal result');
    const pending = results.at(-1);
    if (pending.equal || JSON.stringify(pending.channels) !== '[0,0,0,1]')
      throw Error('Wrong pending disposal result');
    let closed = false;
    try {
      comparator.enqueue(left, right, 1, 1, 'closed');
    } catch (error) {
      closed = /closed/.test(error.message);
    }
    if (!closed) throw Error('Closed comparator accepted work');
    const lossGl = document.createElement('canvas').getContext('webgl2');
    if (!lossGl) throw Error('Context-loss control unavailable');
    const loss = new Rgba8TextureComparison(lossGl);
    try {
      const extension = lossGl.getExtension('WEBGL_lose_context');
      if (!extension) throw Error('Context-loss extension unavailable');
      extension.loseContext();
      lossGl.getError();
      lossGl.getError(); // Context loss must remain detectable after the one-shot error.
      let rejected = false;
      try {
        loss.flush();
      } catch (error) {
        rejected = /context lost/.test(error.message);
      }
      if (!rejected) throw Error('A lost context could yield a false equality result');
    } finally {
      try {
        loss.dispose();
      } catch (error) {
        if (!/context lost/.test(error.message)) throw error;
      }
    }
  } catch (error) {
    failures.push({error: error.stack});
  } finally {
    comparator.dispose();
    for (const texture of textures) gl.deleteTexture(texture);
    gl.deleteSampler(sampler);
    gl.deleteBuffer(pbo);
  }
  return {
    available: true,
    cases,
    passed: cases - failures.length,
    failed: failures.length,
    failures,
    results,
    logicalBytesCompared,
    reads,
    readbackBytes,
    expectedReadbackBytes: cases * 16,
    glError: gl.getError(),
    scope:
      'Synthetic RGBA8 scalar CPU oracle vs exact GPU texel comparison/integer OR reduction. Four logical row-origin combinations, single-bit differences in every channel/corner/center, all256adjacent UNORM8pairs in all4channels, tile boundaries, full-HD, poisoned state, batches across updates/resizes, pending disposal, failed-draw refusal, partial-allocation recovery and context-loss refusal, foreign/closed objects. No game assets or frames.',
  };
}
const result = await runSyntheticBrowserProbe({
  options,
  pageMain,
  modules: new Map([['/rgba8-texture-comparison.mjs', readFileSync(module, 'utf8')]]),
  name: 'rgba8-exact-gpu-compare',
});
for (const source of sources) assert.deepEqual(record(source.path), source);
writeFileSync(result.outputPath + '.bound.json', JSON.stringify({sources}, null, 2) + '\n', {
  flag: 'wx',
});
assert.equal(result.available, true);
assert.equal(result.failed, 0);
assert.equal(result.glError, 0);
assert.equal(result.readbackBytes, result.expectedReadbackBytes);
