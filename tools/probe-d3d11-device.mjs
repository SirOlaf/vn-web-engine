import {readFile, readdir, stat, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {
  parseSyntheticBrowserOptions,
  runSyntheticBrowserProbe,
} from './lib/synthetic-browser-probe.mjs';
import {
  instruction,
  destination,
  source,
  literal,
  constant,
  sampleResource,
  samplerOperand,
  sm4SyntheticContainer,
} from './lib/sm4-synthetic-fixtures.mjs';

function fixtures() {
  const position = {
      semanticName: 'SV_Position',
      systemValue: 1,
      register: 0,
      mask: 15,
      readWriteMask: 0,
    },
    color = {semanticName: 'COLOR', register: 1, mask: 15};
  const vertex = (attributes = 2) => {
    const inputs = Array.from({length: attributes}, (_, i) => ({
      semanticName: i === 0 ? 'POSITION' : i === 1 ? 'COLOR' : 'ATTR' + i,
      register: i,
      mask: 15,
    }));
    const ops = inputs.map((p) => instruction(95, [destination(1, p.register)]));
    if (attributes !== 2) ops.push(instruction(104, [[1]]));
    ops.push(
      instruction(103, [destination(2, 0), [1]]),
      instruction(101, [destination(2, 1)]),
      instruction(54, [destination(2, 0), source(1, 0)]),
    );
    if (attributes === 2) ops.push(instruction(54, [destination(2, 1), source(1, 1)]));
    else {
      ops.push(instruction(54, [destination(0, 0), literal([0, 0, 0, 0])]));
      for (let i = 1; i < attributes; i++)
        ops.push(instruction(0, [destination(0, 0), source(0, 0), source(1, i)]));
      ops.push(instruction(54, [destination(2, 1), source(0, 0)]));
    }
    ops.push(instruction(62));
    const words = ops.flat();
    return [
      ...sm4SyntheticContainer([0x10040, words.length + 2, ...words], inputs, [
        position,
        {...color, readWriteMask: 0},
      ]),
    ];
  };
  const pixel = (kind = 'color', slot = 0, sampler = 0) => {
    const ops = [instruction(98, [destination(1, 1)], 2), instruction(101, [destination(2, 0)])];
    if (kind === 'constant')
      ops.push(
        instruction(89, [[0x00208f02, 0, 1]]),
        instruction(0, [destination(2, 0), source(1, 1), constant(0, 0)]),
      );
    else if (kind === 'modulate')
      ops.push(
        instruction(104, [[1]]),
        instruction(88, [[(7 << 12) | (1 << 20), slot], [0x5555]], 3),
        instruction(90, [samplerOperand(sampler)]),
        instruction(69, [
          destination(0, 0),
          literal([0.5, 0.5, 0, 0]),
          sampleResource(slot),
          samplerOperand(sampler),
        ]),
        instruction(56, [destination(0, 0), source(0, 0), source(1, 1)]),
        instruction(56, [destination(2, 0), source(0, 0), literal([2, 2, 2, 1])]),
      );
    else if (kind === 'sample')
      ops.push(
        instruction(88, [[(7 << 12) | (1 << 20), slot], [0x5555]], 3),
        instruction(90, [samplerOperand(sampler)]),
        instruction(69, [
          destination(2, 0),
          source(1, 1),
          sampleResource(slot),
          samplerOperand(sampler),
        ]),
      );
    else ops.push(instruction(54, [destination(2, 0), source(1, 1)]));
    ops.push(instruction(62));
    const words = ops.flat();
    return [
      ...sm4SyntheticContainer(
        [0x40, words.length + 2, ...words],
        [color],
        [{semanticName: 'SV_Target', register: 0, mask: 15, readWriteMask: 0}],
      ),
    ];
  };
  return {
    vertex: vertex(),
    vertex16: vertex(16),
    pixel: pixel(),
    constantPixel: pixel('constant'),
    samplePixel: pixel('sample', 124, 15),
    modulatePixel: pixel('modulate', 124, 15),
  };
}

/** Real library exports and public contract calls on generated data; no game assets/screenshots. */
async function pageMain(fixture) {
  const {NativeLibraryLoader} = await import('/runtime/platform/native-libraries.js');
  const {D3D11, D3D11_SDK_VERSION} = await import('/runtime/native/d3d11/contract.js');
  const {d3d11WebGl2Library} = await import('/runtime/native/d3d11/library.js');
  const canvas = document.createElement('canvas'),
    gl = canvas.getContext('webgl2', {antialias: false});
  if (!gl) return {available: false, reason: 'WebGL2 unavailable'};
  const adapter = {
    vendor: gl.getParameter(gl.VENDOR),
    renderer: gl.getParameter(gl.RENDERER),
    version: gl.getParameter(gl.VERSION),
  };
  const loader = new NativeLibraryLoader([d3d11WebGl2Library(() => gl)], {
    locate: (fileName) => ({kind: 'system', fileName}),
  });
  const loaded = loader.load('D3D11.DLL');
  if (loaded.status !== 'loaded') throw Error('D3D11 system library did not load');
  const exports = loaded.library.exports(D3D11),
    created = exports.d3d11CreateDevice(null, 1, 0, 0x20, null, D3D11_SDK_VERSION);
  if (created.hr !== 0) throw Error('Device creation failed ' + created.hr);
  const device = created.device,
    ctx = created.immediateContext,
    objects = [],
    rows = [];
  function own(result) {
    if (result.hr !== 0 || !result.value) throw Error('Native creation failed ' + result.hr);
    objects.push(result.value);
    return result.value;
  }
  const buffer = (bytes, bindFlags = 1, changes = {}) =>
    own(
      device.createBuffer(
        {
          byteWidth: bytes.length,
          usage: 0,
          bindFlags,
          cpuAccessFlags: 0,
          miscFlags: 0,
          structureByteStride: 0,
          ...changes,
        },
        {data: bytes, rowPitch: 0, slicePitch: 0},
      ),
    );
  const texture = (changes = {}, initial = null) =>
    own(
      device.createTexture2D(
        {
          width: 4,
          height: 4,
          mipLevels: 1,
          arraySize: 1,
          format: 28,
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
  const element = (semanticName, format, offset = 0xffffffff) => ({
    semanticName,
    semanticIndex: 0,
    format,
    inputSlot: 0,
    alignedByteOffset: offset,
    inputSlotClass: 0,
    instanceDataStepRate: 0,
  });
  const target = texture(),
    rtv = own(device.createRenderTargetView(target, null)),
    staging = texture({usage: 3, bindFlags: 0, cpuAccessFlags: 0x20000});
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
  const vs = own(device.createVertexShader(Uint8Array.from(fixture.vertex), null)),
    ps = own(device.createPixelShader(Uint8Array.from(fixture.pixel), null)),
    cbPs = own(device.createPixelShader(Uint8Array.from(fixture.constantPixel), null)),
    samplePs = own(device.createPixelShader(Uint8Array.from(fixture.samplePixel), null));
  const layout = own(
    device.createInputLayout(
      [element('POSITION', 6), element('COLOR', 87)],
      Uint8Array.from(fixture.vertex),
    ),
  );
  const floatBytes = (values) => new Uint8Array(new Float32Array(values).buffer);
  const positions = [
    [-1, 1, 0.25],
    [3, 1, 0.25],
    [-1, -3, 0.25],
  ];
  function packedVertices(color = 0xff206040) {
    const bytes = new Uint8Array(48),
      d = new DataView(bytes.buffer);
    for (let i = 0; i < 3; i++) {
      positions[i].forEach((v, j) => d.setFloat32(i * 16 + j * 4, v, true));
      d.setUint32(i * 16 + 12, color, true);
    }
    return bytes;
  }
  const packed = buffer(packedVertices());
  function setup(vertex = vs, pixel = ps, input = layout, stream = packed, stride = 16) {
    ctx.clearState();
    ctx.vsSetShader(vertex, []);
    ctx.psSetShader(pixel, []);
    ctx.iaSetInputLayout(input);
    ctx.iaSetVertexBuffers(0, [stream], [stride], [0]);
    ctx.iaSetPrimitiveTopology(4);
    ctx.rsSetState(raster);
    ctx.rsSetViewports([{topLeftX: 0, topLeftY: 0, width: 4, height: 4, minDepth: 0, maxDepth: 1}]);
    ctx.omSetRenderTargets([rtv], null);
    ctx.clearRenderTargetView(rtv, [0, 0, 0, 0]);
  }
  const fill = (pixel) => Uint8Array.from(Array(16).fill(pixel).flat());
  const hash = async (bytes) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((n) => n.toString(16).padStart(2, '0'))
      .join('');
  async function record(name, expected) {
    ctx.copyResource(staging, target);
    const mapped = ctx.map(staging, 0, 1, 0);
    if (mapped.hr !== 0) throw Error('Staging read failed ' + mapped.hr);
    const actual = mapped.value.data.slice();
    ctx.unmap(staging, 0);
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
  try {
    setup();
    ctx.draw(3, 0);
    await record('public-draw-bgra-input', fill([32, 96, 64, 255]));
    // Fixed-state caching is owned by the concrete Native device, including
    // invalidation at private texture operations and external GL handoff.
    const originalViewport = gl.viewport;
    let viewportWrites = 0;
    gl.viewport = function (...args) {
      viewportWrites++;
      return originalViewport.apply(gl, args);
    };
    try {
      setup();
      ctx.draw(3, 0);
      const before = viewportWrites;
      ctx.draw(3, 0);
      rows.push({name: 'public-fixed-state-repeat', passed: viewportWrites === before});
      const temporary = device.createBuffer(
        {
          byteWidth: 48,
          usage: 0,
          bindFlags: 1,
          cpuAccessFlags: 0,
          miscFlags: 0,
          structureByteStride: 0,
        },
        {data: packedVertices(), rowPitch: 0, slicePitch: 0},
      ).value;
      temporary.release();
      ctx.draw(3, 0);
      rows.push({
        name: 'public-fixed-state-unrelated-buffer-retirement',
        passed: viewportWrites === before,
      });
      await record('public-fixed-state-repeat-pixels', fill([32, 96, 64, 255]));
      setup();
      ctx.draw(3, 0);
      ctx.updateSubresource(packed, 0, null, packedVertices(0xff00ff00), 0, 0);
      ctx.rsSetViewports([
        {topLeftX: 0, topLeftY: 0, width: 2, height: 4, minDepth: 0, maxDepth: 1},
      ]);
      ctx.draw(3, 0);
      await record(
        'public-fixed-state-viewport-mutation',
        Uint8Array.from(
          Array.from({length: 16}, (_, i) =>
            i % 4 < 2 ? [0, 255, 0, 255] : [32, 96, 64, 255],
          ).flat(),
        ),
      );
      ctx.updateSubresource(packed, 0, null, packedVertices(), 0, 0);
      setup();
      const blendDesc = {
        alphaToCoverageEnable: false,
        independentBlendEnable: false,
        renderTarget: Array.from({length: 8}, () => ({
          blendEnable: true,
          srcBlend: 14,
          destBlend: 1,
          blendOp: 1,
          srcBlendAlpha: 2,
          destBlendAlpha: 1,
          blendOpAlpha: 1,
          renderTargetWriteMask: 15,
        })),
      };
      const constantBlend = own(device.createBlendState(blendDesc));
      ctx.omSetBlendState(constantBlend, [1, 0, 0, 1], 0xffffffff);
      ctx.draw(3, 0);
      ctx.omSetBlendState(constantBlend, [0, 1, 0, 1], 0xffffffff);
      ctx.draw(3, 0);
      await record('public-fixed-state-blend-factor-mutation', fill([0, 96, 0, 255]));
      const redBlend = own(
        device.createBlendState({
          ...blendDesc,
          renderTarget: blendDesc.renderTarget.map((t) => ({
            ...t,
            blendEnable: false,
            renderTargetWriteMask: 1,
          })),
        }),
      );
      setup();
      ctx.omSetBlendState(redBlend, [0, 0, 0, 0], 0xffffffff);
      ctx.draw(3, 0);
      ctx.clearRenderTargetView(rtv, [0, 0.25, 0.5, 1]);
      ctx.draw(3, 0);
      await record('public-fixed-state-clear-restores-mask', fill([32, 64, 128, 255]));
      setup();
      ctx.draw(3, 0);
      const lease = device.acquireColorTexture(target);
      try {
        lease.prepare();
        gl.colorMask(false, false, false, false);
        gl.viewport(0, 0, 1, 1);
        ctx.updateSubresource(packed, 0, null, packedVertices(0xff0000ff), 0, 0);
        ctx.draw(3, 0);
      } finally {
        lease.dispose();
      }
      await record('public-fixed-state-publication-handoff', fill([0, 0, 255, 255]));
      ctx.updateSubresource(packed, 0, null, packedVertices(), 0, 0);
      setup();
      ctx.draw(3, 0);
      ctx.flush();
      gl.colorMask(false, false, false, false);
      gl.viewport(0, 0, 1, 1);
      ctx.updateSubresource(packed, 0, null, packedVertices(0xff00ff00), 0, 0);
      ctx.draw(3, 0);
      await record('public-fixed-state-flush-handoff', fill([0, 255, 0, 255]));
      ctx.updateSubresource(packed, 0, null, packedVertices(), 0, 0);
      const scissor = own(device.createRasterizerState({...raster.getDesc(), scissorEnable: true}));
      setup();
      ctx.rsSetState(scissor);
      ctx.rsSetScissorRects([{left: 0, top: 0, right: 2, bottom: 4}]);
      ctx.draw(3, 0);
      ctx.updateSubresource(packed, 0, null, packedVertices(0xff00ff00), 0, 0);
      ctx.rsSetScissorRects([{left: 2, top: 0, right: 4, bottom: 4}]);
      ctx.draw(3, 0);
      await record(
        'public-fixed-state-scissor-mutation',
        Uint8Array.from(
          Array.from({length: 16}, (_, i) =>
            i % 4 < 2 ? [32, 96, 64, 255] : [0, 255, 0, 255],
          ).flat(),
        ),
      );
    } finally {
      gl.viewport = originalViewport;
      ctx.updateSubresource(packed, 0, null, packedVertices(), 0, 0);
      setup();
    }

    for (const [format, typed] of [
      [57, Uint16Array],
      [42, Uint32Array],
    ]) {
      const cut = format === 57 ? 0xffff : 0xffffffff,
        indices = buffer(new Uint8Array(new typed([99, 1, 2, 3, cut, 1, 2, 3]).buffer), 2);
      setup();
      ctx.iaSetIndexBuffer(indices, format, 0);
      ctx.drawIndexed(3, 1, -1);
      await record('public-indexed-base-' + format, fill([32, 96, 64, 255]));
      setup();
      ctx.iaSetPrimitiveTopology(5);
      ctx.iaSetIndexBuffer(indices, format, 0);
      ctx.drawIndexed(7, 1, -1);
      await record('public-strip-cuts-' + format, fill([32, 96, 64, 255]));
    }
    setup();
    ctx.updateSubresource(packed, 0, null, packedVertices(0xff80c040), 0, 0);
    ctx.draw(3, 0);
    await record('public-vertex-update', fill([128, 192, 64, 255]));
    const dynamic = buffer(packedVertices(), 1, {usage: 2, cpuAccessFlags: 0x10000});
    setup(vs, ps, layout, dynamic);
    const mapped = ctx.map(dynamic, 0, 4, 0);
    if (mapped.hr !== 0) throw Error('Dynamic vertex map failed');
    mapped.value.data.set(packedVertices(0xffa05020));
    ctx.unmap(dynamic, 0);
    ctx.draw(3, 0);
    await record('public-dynamic-discard-input', fill([160, 80, 32, 255]));
    const zeros = buffer(packedVertices(0)),
      cb = buffer(floatBytes([1, 0, 0, 1]), 4);
    setup(vs, cbPs, layout, zeros);
    ctx.psSetConstantBuffers(0, [cb]);
    ctx.draw(3, 0);
    await record('public-raw-constants', fill([255, 0, 0, 255]));
    ctx.updateSubresource(cb, 0, null, floatBytes([0, 1, 0, 1]), 0, 0);
    ctx.draw(3, 0);
    await record('public-constant-update', fill([0, 255, 0, 255]));
    ctx.psSetConstantBuffers(0, [null]);
    ctx.draw(3, 0);
    await record('public-unbound-constants-zero', fill([0, 0, 0, 0]));
    const imageBytes = Uint8Array.from(
      Array.from({length: 16}, (_, i) => [(i % 4) * 40, Math.floor(i / 4) * 50, 90, 255]).flat(),
    );
    const image = texture({}, [{data: imageBytes, rowPitch: 16, slicePitch: 0}]),
      srv = own(device.createShaderResourceView(image, null));
    const sampler = own(
      device.createSamplerState({
        filter: 0,
        addressU: 3,
        addressV: 3,
        addressW: 1,
        mipLodBias: 0,
        maxAnisotropy: 2,
        comparisonFunc: 1,
        borderColor: [0, 0, 0, 0],
        minLod: -1000,
        maxLod: 1000,
      }),
    );
    const uvLayout = own(
      device.createInputLayout(
        [element('POSITION', 6), element('COLOR', 16)],
        Uint8Array.from(fixture.vertex),
      ),
    );
    const uv = [];
    for (let i = 0; i < 3; i++)
      uv.push(
        ...positions[i],
        ...[
          [0, 0],
          [2, 0],
          [0, 2],
        ][i],
      );
    const uvBuffer = buffer(floatBytes(uv));
    setup(vs, samplePs, uvLayout, uvBuffer, 20);
    ctx.psSetShaderResources(124, [srv]);
    ctx.psSetSamplers(15, [sampler]);
    ctx.draw(3, 0);
    await record('public-sparse-resource-sampler', imageBytes);
    const sourceOnly = texture({bindFlags: 8}, [{data: imageBytes, rowPitch: 16, slicePitch: 0}]),
      sourceOnlyView = own(device.createShaderResourceView(sourceOnly, null));
    for (const [index, selected] of [sourceOnlyView, srv, sourceOnlyView].entries()) {
      ctx.psSetShaderResources(124, [selected]);
      ctx.draw(3, 0);
      await record('public-reflected-source-switch-' + index, imageBytes);
    }

    // A point sample at an exact native texel boundary selects floor(v * height).
    const boundaryUv = new Float32Array(uv);
    for (let i = 0; i < 3; i++) boundaryUv[i * 5 + 4] = 0.5;
    ctx.updateSubresource(uvBuffer, 0, null, new Uint8Array(boundaryUv.buffer), 0, 0);
    ctx.draw(3, 0);
    await record(
      'public-source-point-boundary',
      Uint8Array.from(Array.from({length: 16}, (_, i) => [(i % 4) * 40, 100, 90, 255]).flat()),
    );
    ctx.updateSubresource(uvBuffer, 0, null, floatBytes(uv), 0, 0);
    const bgraBytes = imageBytes.slice();
    for (let i = 0; i < bgraBytes.length; i += 4) {
      bgraBytes[i] = imageBytes[i + 2];
      bgraBytes[i + 2] = imageBytes[i];
    }
    const bgra = texture({format: 87}, [{data: bgraBytes, rowPitch: 16, slicePitch: 0}]),
      bgraView = own(device.createShaderResourceView(bgra, null));
    ctx.psSetShaderResources(124, [bgraView]);
    ctx.draw(3, 0);
    await record('public-draw-after-private-decoder', imageBytes);
    const rangePixels = fill([200, 100, 50, 255]).subarray(0, 16),
      chain = texture({mipLevels: 3}, [
        {data: imageBytes, rowPitch: 16, slicePitch: 0},
        {data: rangePixels, rowPitch: 8, slicePitch: 0},
        {data: new Uint8Array([25, 75, 125, 255]), rowPitch: 4, slicePitch: 0},
      ]),
      rangeView = own(
        device.createShaderResourceView(chain, {
          format: 28,
          viewDimension: 4,
          texture2D: {mostDetailedMip: 1, mipLevels: 1},
        }),
      );
    ctx.psSetShaderResources(124, [rangeView]);
    ctx.draw(3, 0);
    await record('public-view-range-alias', fill([200, 100, 50, 255]));
    ctx.psSetShaderResources(124, [null]);
    ctx.draw(3, 0);
    await record('public-null-resource-zero', fill([0, 0, 0, 0]));
    // Native output ranges apply before blending. Keep consecutive overlapping
    // draws together so a staging read cannot hide a precision difference.
    const modulatePs = own(device.createPixelShader(Uint8Array.from(fixture.modulatePixel), null)),
      modulation = buffer(packedVertices(0xff80ffc8)),
      onePixel = texture({width: 1, height: 1, bindFlags: 8}, [
        {data: Uint8Array.of(128, 73, 87, 254), rowPitch: 4, slicePitch: 0},
      ]),
      onePixelView = own(device.createShaderResourceView(onePixel, null)),
      alphaBlend = own(
        device.createBlendState({
          alphaToCoverageEnable: false,
          independentBlendEnable: false,
          renderTarget: Array.from({length: 8}, () => ({
            blendEnable: true,
            srcBlend: 5,
            destBlend: 6,
            blendOp: 1,
            srcBlendAlpha: 2,
            destBlendAlpha: 6,
            blendOpAlpha: 1,
            renderTargetWriteMask: 15,
          })),
        }),
      );
    const modulate = (stream = modulation) => {
      setup(vs, modulatePs, layout, stream);
      ctx.psSetShaderResources(124, [onePixelView]);
      ctx.psSetSamplers(15, [sampler]);
      ctx.omSetBlendState(alphaBlend, [0, 0, 0, 0], 0xffffffff);
    };
    modulate();
    ctx.draw(3, 0);
    await record('public-unorm-range-first-blend', fill([128, 145, 136, 254]));
    modulate();
    ctx.draw(3, 0);
    ctx.draw(3, 0);
    await record('public-unorm-range-consecutive-blend', fill([129, 146, 136, 255]));
    ctx.updateSubresource(onePixel, 0, null, Uint8Array.of(255, 128, 64, 128), 4, 0);
    modulate(buffer(packedVertices(0xffffffff)));
    ctx.draw(3, 0);
    await record('public-unorm-source-clamp-before-blend', fill([128, 128, 64, 128]));
    const v16 = own(device.createVertexShader(Uint8Array.from(fixture.vertex16), null)),
      elements = Array.from({length: 16}, (_, i) =>
        element(i === 0 ? 'POSITION' : i === 1 ? 'COLOR' : 'ATTR' + i, 16),
      );
    const layout16 = own(device.createInputLayout(elements, Uint8Array.from(fixture.vertex16))),
      values = [];
    for (let v = 0; v < 3; v++) {
      values.push(...positions[v].slice(0, 2));
      for (let a = 1; a < 16; a++) values.push(1 / 32, 1 / 64);
    }
    const input16 = buffer(floatBytes(values));
    setup(v16, ps, layout16, input16, 128);
    ctx.draw(3, 0);
    await record('public-sixteen-attribute-planes', fill([120, 60, 0, 255]));
    ctx.flush();
  } catch (error) {
    rows.push({name: 'public-device-exception', passed: false, error: error.stack});
  } finally {
    for (const object of objects) object.release();
    ctx.release();
    device.release();
    loader.free(loaded.library);
    loader.dispose();
  }
  rows.push({
    name: 'public-final-device-retired',
    passed: device.queryInterface('db6f6ddb-ac77-4e88-8253-819df9bbf140').value === null,
  });
  const failures = rows.filter((r) => !r.passed);
  return {
    available: true,
    adapter,
    cases: rows.length,
    failed: failures.length,
    failures,
    rows,
    publicContractCalls: true,
    syntheticDataOnly: true,
    screenshots: false,
  };
}

if (process.argv.includes('--help'))
  console.log(
    'Usage: node tools/probe-d3d11-device.mjs [--browser path] [--output new-results.json]',
  );
else
  try {
    const root = new URL('../', import.meta.url),
      paths = [
        'tools/probe-d3d11-device.mjs',
        'tools/lib/synthetic-browser-probe.mjs',
        'tools/lib/sm4-synthetic-fixtures.mjs',
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
    const fixture = fixtures(),
      fixtureSha256 = createHash('sha256').update(JSON.stringify(fixture)).digest('hex');
    const result = await runSyntheticBrowserProbe({
      options: parseSyntheticBrowserOptions(process.argv.slice(2)),
      fixture,
      pageMain,
      runtimeRoot: fileURLToPath(new URL('dist/', root)),
      name: 'vn-d3d11-public-device',
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
