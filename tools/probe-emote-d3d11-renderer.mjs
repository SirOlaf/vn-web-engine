import {readFile, readdir, stat, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve, join} from 'node:path';
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
    vertexSha256: bank.vertex.map((bytes) => createHash('sha256').update(bytes).digest('hex')),
    pixelSha256: bank.pixel.map((bytes) => createHash('sha256').update(bytes).digest('hex')),
  };
}

/** Generated draws only. Readbacks remain numeric and are never presented. */
async function pageMain(fixture) {
  const {NativeLibraryLoader} = await import('/runtime/platform/native-libraries.js');
  const {D3D11} = await import('/runtime/native/d3d11/contract.js');
  const {d3d11WebGl2Library} = await import('/runtime/native/d3d11/library.js');
  const {EmoteD3d11Shaders} =
    await import('/runtime/native/emotedriver/runtime/render/d3d11-shaders.js');
  const {EmoteD3d11Textures} =
    await import('/runtime/native/emotedriver/runtime/render/d3d11-textures.js');
  const {EmoteD3d11Renderer} =
    await import('/runtime/native/emotedriver/runtime/render/renderer-d3d11.js');
  const {EmoteD3d11Target} =
    await import('/runtime/native/emotedriver/runtime/render/d3d11-target.js');
  const {EmoteD3d11Matrices} =
    await import('/runtime/native/emotedriver/runtime/render/d3d11-matrices.js');
  const {EmoteRenderer, EmoteTextureCache} =
    await import('/reference/native/emotedriver/renderer.js');
  const {WebGLDrawTarget} = await import('/reference/graphics/webgl-draw.js');
  const width = 32,
    height = 24;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const gl = canvas.getContext('webgl2', {antialias: false});
  if (!gl) return {available: false, reason: 'WebGL2 unavailable'};
  const loader = new NativeLibraryLoader([d3d11WebGl2Library(() => gl)], {
    locate: (fileName) => ({kind: 'system', fileName}),
  });
  const loaded = loader.load('d3d11.dll');
  if (loaded.status !== 'loaded') throw Error('D3D11 did not load');
  const created = loaded.library.exports(D3D11).d3d11CreateDevice(null, 1, 0, 0, null, 7);
  if (created.hr !== 0) throw Error('Device creation ' + created.hr);
  const device = created.device,
    ctx = created.immediateContext,
    objects = [];
  // The native compositor establishes the viewport; E-mote target binding preserves it.
  ctx.rsSetViewports([{topLeftX: 0, topLeftY: 0, width, height, minDepth: 0, maxDepth: 1}]);
  const own = (r) => {
    if (r.hr !== 0 || !r.value) throw Error('Resource creation ' + r.hr);
    objects.push(r.value);
    return r.value;
  };
  const texture = (changes) =>
    own(
      device.createTexture2D(
        {
          width,
          height,
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
        null,
      ),
    );
  const output = texture(),
    view = own(device.createRenderTargetView(output, null));
  const staging = texture({usage: 3, bindFlags: 0, cpuAccessFlags: 0x20000});
  const resourceIds = new WeakMap(),
    resourceDefinitions = [];
  let shaderInputs;
  let resourceSerial = 0,
    recording = false,
    calls = [],
    meshBuffers = [];
  const idOf = (resource) => {
    if (!resourceIds.has(resource)) resourceIds.set(resource, ++resourceSerial);
    return resourceIds.get(resource);
  };
  const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const encode = (value) => {
    if (value === null || typeof value !== 'object') return value;
    if (ArrayBuffer.isView(value))
      return {
        type: value.constructor.name,
        hex: hex(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
      };
    if (typeof value.release === 'function') return {resource: idOf(value)};
    if (Array.isArray(value)) return value.map(encode);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encode(v)]));
  };
  const observedDevice = new Proxy(device, {
    get(target, key) {
      const method = target[key];
      if (typeof method !== 'function') return method;
      return (...args) => {
        const result = method.apply(target, args);
        if (key.startsWith('create') && result.value) {
          const id = idOf(result.value);
          if (
            key === 'createVertexShader' ||
            key === 'createPixelShader' ||
            key === 'createInputLayout'
          ) {
            const stage = key === 'createPixelShader' ? 'pixel' : 'vertex';
            const bytecode = key === 'createInputLayout' ? args[1] : args[0];
            const index = shaderInputs[stage].indexOf(bytecode);
            if (index < 0) throw Error('Unidentified native shader resource');
            resourceDefinitions.push({
              id,
              method: key,
              stage,
              index,
              sha256: fixture[stage + 'Sha256'][index],
              ...(key === 'createInputLayout' ? {elements: encode(args[0])} : {}),
            });
          } else resourceDefinitions.push({id, method: key, args: encode(args)});
        }
        if (recording) {
          calls.push({method: key, args: encode(args), result: encode(result)});
          if (key === 'createBuffer' && args[0].bindFlags === 1 && result.value)
            meshBuffers.push(new Uint8Array(args[1].data).slice());
        }
        return result;
      };
    },
  });
  const observedContext = new Proxy(ctx, {
    get(target, key) {
      const method = target[key];
      if (typeof method !== 'function') return method;
      return (...args) => {
        if (recording) calls.push({method: key, args: encode(args)});
        return method.apply(target, args);
      };
    },
  });
  const decode = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  shaderInputs = {vertex: fixture.vertex.map(decode), pixel: fixture.pixel.map(decode)};
  const bank = new EmoteD3d11Shaders(observedDevice, {...fixture, ...shaderInputs});
  const textures = new EmoteD3d11Textures(observedDevice);
  const native = new EmoteD3d11Renderer(observedDevice, observedContext, bank, textures);
  const nativeOutput = new EmoteD3d11Target(view, null);
  const target = new WebGLDrawTarget(document.createElement('canvas'), width, height);
  const images = new Map();
  let nextId = 1;
  const host = {
    addTexture(image) {
      const id = nextId++;
      images.set(id, image);
      target.prepareImage(image);
      return id;
    },
    removeTexture(id) {
      const image = images.get(id);
      if (image) target.invalidate(image);
      images.delete(id);
    },
  };
  const cache = new EmoteTextureCache(host),
    old = new EmoteRenderer(host, cache, width, height);
  const sourceIds = new WeakMap(),
    legacySources = new Map(),
    nativeSources = new Map();
  let sourceSerial = 0;
  const sourceId = (source) => {
    if (!sourceIds.has(source)) sourceIds.set(source, ++sourceSerial);
    return sourceIds.get(source);
  };
  const oldAcquire = cache.acquire.bind(cache),
    nativeAcquire = textures.acquire.bind(textures);
  cache.acquire = (source, commands) => {
    const entry = oldAcquire(source, commands);
    legacySources.set(entry.id, sourceId(source));
    return entry;
  };
  textures.acquire = (source, spec) => {
    const entry = nativeAcquire(source, spec);
    nativeSources.set(idOf(entry.view), sourceId(source));
    return entry;
  };
  const matrix = Float32Array.of(2 / width, 0, 0, 0, 0, -2 / height, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1);
  const grid = (cols = 1, rows = 1, rect = [-12, -8, 12, 8], warp = false) => {
    const points = new Float32Array((cols + 1) * (rows + 1) * 2);
    for (let j = 0; j <= rows; j++)
      for (let i = 0; i <= cols; i++) {
        const offset = (j * (cols + 1) + i) * 2;
        points[offset] =
          rect[0] + ((rect[2] - rect[0]) * i) / cols + (warp ? Math.sin(j + i) * 0.7 : 0);
        points[offset + 1] =
          rect[1] + ((rect[3] - rect[1]) * j) / rows + (warp ? Math.cos(j - i) * 0.7 : 0);
      }
    return {cols, rows, points};
  };
  const atlas = (type, bytes, w = 4, h = 4) => ({
    spec: 'win',
    sources: new Map([
      ['atlas', {texture: {type, width: w, height: h, pixel: {bytes: Uint8Array.from(bytes)}}}],
    ]),
  });
  const item = (changes = {}) => ({
    blank: false,
    nodeId: 1,
    clipFlags: 0,
    bm: 0,
    bmParam: 0,
    grayscaleMode: 0,
    grayscaleLevel: 0,
    effectMode: 0,
    effectLevel: 0,
    z: 0,
    texIndex: 0,
    file: null,
    source: null,
    attr: 0,
    left: 0,
    top: 0,
    width: 4,
    height: 4,
    opa: 1,
    colors: Uint32Array.of(0x808080ff, 0x808080ff, 0x808080ff, 0x808080ff),
    objTriPriority: 0,
    coordinate: 0,
    mesh: null,
    grid: grid(),
    stencilType: 0,
    alphaTest: false,
    alphaScale: 1,
    alphaOffset: 0,
    stencilParent: null,
    composite: [],
    ...changes,
  });
  const solid = (color) => Uint32Array.of(color, color, color, color);
  const background = () => item({colors: solid(0x305070b3), grid: grid(1, 1, [-16, -12, 16, 12])});
  const cases = [];
  const add = (name, items, smoothing = false) => cases.push({name, items, smoothing});
  add('empty', []);
  for (const attr of [0, 4])
    for (const color of [0x808080ff, 0xc0402080, 0xffffffff])
      add(`solid-${attr}-${color.toString(16)}`, [item({attr, colors: solid(color)})]);
  const gradient = Uint32Array.of(0xff0000ff, 0x00ff0080, 0x0000ffff, 0x80808040);
  for (const [cols, rows] of [
    [1, 1],
    [2, 3],
    [17, 5],
    [1, 7],
    [7, 1],
  ])
    add(`grid-${cols}x${rows}`, [
      item({grid: grid(cols, rows, undefined, true), colors: gradient}),
    ]);
  const sources = [
    ['L8', Array.from({length: 16}, (_, i) => i * 17)],
    ['A8', Array.from({length: 16}, (_, i) => i * 17)],
    ['A8L8', Array.from({length: 32}, (_, i) => (i % 2 ? 255 - (i >> 1) * 17 : (i >> 1) * 17))],
    ['DXT1', [0, 248, 224, 7, 0x1b, 0xe4, 0xb1, 0x4e]],
    ['DXT3', [...Array(8).fill(0x88), 224, 7, 31, 0, 0x1b, 0xe4, 0xb1, 0x4e]],
    ['DXT5', [192, 32, 0x88, 0xc6, 0xfa, 0x88, 0xc6, 0xfa, 0, 248, 31, 0, 0x1b, 0xe4, 0xb1, 0x4e]],
    [
      'BC7',
      [
        0x40, 0xa2, 0x74, 0x19, 0xbb, 0x51, 0xd3, 0x07, 0x83, 0xaa, 0xdd, 0x8c, 0x12, 0x64, 0x99,
        0xfe,
      ],
    ],
  ].map(([type, bytes]) => [type, atlas(type, bytes)]);
  for (const [type, file] of sources)
    for (const smoothing of [false, true])
      for (const attr of [0, 4])
        add(`atlas-${type}-${attr}-${smoothing}`, [item({file, attr})], smoothing);
  for (const bm of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 0x10, 0x13, 0x14, 0x15])
    add(`blend-${bm.toString(16)}`, [
      background(),
      item({bm, colors: solid(0x90703099), file: sources[5][1]}),
    ]);
  for (let grayscaleMode = 0; grayscaleMode <= 5; grayscaleMode++)
    add(`filter-${grayscaleMode}`, [
      background(),
      item({grayscaleMode, grayscaleLevel: 0xb0704080, file: sources[5][1]}),
    ]);
  for (let bm = 0x100; bm <= 0x10d; bm++)
    add(`buffered-${bm.toString(16)}`, [
      background(),
      item({bm, bmParam: bm === 0x10c ? -3 : bm === 0x10d ? 0.08 : 0, file: sources[5][1]}),
    ]);
  for (const [type, file] of sources.slice(0, 3)) {
    for (const smoothing of [false, true]) {
      add(
        `half-texel-${type}-${smoothing}`,
        [item({file, grid: grid(1, 1, [-9, -7, 8, 6])})],
        smoothing,
      );
    }
  }
  for (const bm of [0, 0x10, 0x13, 0x118]) {
    for (const [type, file] of sources.slice(3)) {
      const parent = item({
        stencilType: 5,
        alphaScale: 1,
        alphaOffset: 0,
        composite: [
          item({file, grid: grid(1, 1, [-10, -8, 0, 8])}),
          item({file, grid: grid(2, 3, [0, -8, 10, 8])}),
        ],
      });
      add(`corpus-values-${bm.toString(16)}-${type}`, [
        background(),
        item({file, bm, stencilParent: parent}),
      ]);
    }
  }
  for (const alphaTest of [false, true])
    for (const stencilType of [1, 2, 5, 6]) {
      const parent = item({
        stencilType,
        alphaTest,
        alphaScale: 0.7,
        alphaOffset: 0.1,
        file: sources[1][1],
        grid: grid(1, 1, [-9, -7, 8, 6]),
        composite: [item({file: sources[1][1]})],
      });
      add(`mask-${stencilType}-${alphaTest}`, [
        background(),
        item({stencilParent: parent, file: sources[5][1]}),
      ]);
    }
  for (const roles of [
    [1, 1],
    [1, 2],
    [2, 1],
    [2, 2],
    [1, 1, 2],
  ]) {
    let parent = null;
    for (const [i, stencilType] of roles.entries())
      parent = item({
        stencilType,
        stencilParent: parent,
        alphaScale: 0.6,
        alphaOffset: 0.2,
        file: sources[1][1],
        grid: grid(1, 1, [-11 + i, -9 + i, 11 - i, 9 - i]),
      });
    add(`nested-${roles.join('-')}`, [
      background(),
      item({stencilParent: parent, file: sources[5][1]}),
    ]);
  }
  // Native VS1 dots one constant register per output component. Transpose
  // WebGL array storage as raw words, preserving every float32 bit pattern.
  const nativeMatrixOf = (source) => {
    const result = new Float32Array(16),
      dst = new Uint32Array(result.buffer),
      src = new Uint32Array(source.buffer, source.byteOffset, 16);
    for (let row = 0; row < 4; row++)
      for (let column = 0; column < 4; column++) dst[row * 4 + column] = src[column * 4 + row];
    return result;
  };
  const affine = (xx, xy, yx, yy, dx, dy) =>
    Float32Array.of(
      (2 * xx) / width,
      (-2 * yx) / height,
      0,
      0,
      (2 * xy) / width,
      (-2 * yy) / height,
      0,
      0,
      0,
      0,
      0,
      0,
      (2 * dx) / width,
      (-2 * dy) / height,
      0,
      1,
    );
  const transforms = [
    ['translation', affine(1, 0, 0, 1, 4, -3), [16, 6, 24, 12]],
    ['quarter-turn', affine(0, -1, 1, 0, 0, 0), [13, 8, 19, 16]],
    ['reflection', affine(-1, 0, 0, 1, 2, 0), [14, 9, 22, 15]],
    ['shear', affine(1, 0.5, 0, 1, 0, 0), [10, 9, 22, 15]],
  ];
  for (const [name, transform] of transforms)
    cases.push({
      name: 'matrix-' + name,
      transform,
      items: [item({grid: grid(1, 1, [-4, -3, 4, 3]), attr: 4, colors: solid(0x204060ff)})],
      smoothing: false,
    });
  const hash = async (bytes) =>
    [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  const rows = [];
  let compared = 0;
  try {
    for (const test of cases) {
      try {
        cache.beginFrame();
        old.transform.set(test.transform ?? matrix);
        const nativeMatrix = nativeMatrixOf(old.transform);
        const commands = old.render(test.items, test.smoothing);
        target.draw({sprites: [], commands, offscreen: true}, (id) => images.get(id));
        const expected = target.readRenderSurface(old.surface, width, height);
        ctx.clearRenderTargetView(view, [0, 0, 0, 0]);
        recording = true;
        calls = [];
        meshBuffers = [];
        native.render(test.items, nativeOutput.binding, nativeMatrix, test.smoothing);
        recording = false;
        const legacyMeshes = commands.filter(
          (command) => command.kind === 'triangles' && command.depthClip === false,
        );
        const logicalMeshes = meshBuffers.map((bytes) => {
          const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
            words = new Float32Array((bytes.length / 20) * 9);
          for (let v = 0; v < bytes.length / 20; v++) {
            const offset = v * 20,
              out = v * 9;
            words[out] = view.getFloat32(offset, true);
            words[out + 1] = view.getFloat32(offset + 4, true);
            words[out + 2] = 0;
            words[out + 3] = bytes[offset + 10] / 255;
            words[out + 4] = bytes[offset + 9] / 255;
            words[out + 5] = bytes[offset + 8] / 255;
            words[out + 6] = bytes[offset + 11] / 255;
            words[out + 7] = view.getFloat32(offset + 12, true);
            words[out + 8] = view.getFloat32(offset + 16, true);
          }
          return new Uint8Array(words.buffer);
        });
        const mappedVerticesExact =
          logicalMeshes.length === legacyMeshes.length &&
          logicalMeshes.every((bytes, i) => {
            const original = new Uint8Array(
              legacyMeshes[i].vertices.buffer,
              legacyMeshes[i].vertices.byteOffset,
              legacyMeshes[i].vertices.byteLength,
            );
            return bytes.length === original.length && bytes.every((b, j) => b === original[j]);
          });
        const nativeTopologies = calls
          .filter((call) => call.method === 'iaSetPrimitiveTopology')
          .map((call) => call.args[0]);
        const mappedTopologiesExact =
          nativeTopologies.length === legacyMeshes.length &&
          nativeTopologies.every(
            (topology, i) => topology === (legacyMeshes[i].topology === 'triangle-strip' ? 5 : 4),
          );
        const definitions = new Map(
          resourceDefinitions.map((definition) => [definition.id, definition]),
        );
        const programKeys = new Map([...old.programs].map(([key, source]) => [source, key]));
        const nativeMaskTextures = resourceDefinitions
          .filter(
            (definition) =>
              definition.method === 'createTexture2D' &&
              definition.args[0].format === 65 &&
              definition.args[0].bindFlags === 0x28,
          )
          .map((definition) => definition.id);
        const legacyMasks = [...(old.masks ?? [])].sort((a, b) => a.id - b.id);
        const nativeSurface = (id) => {
          if (id === idOf(view)) return 'output';
          const texture = definitions.get(id)?.args[0].resource;
          const mask = nativeMaskTextures.indexOf(texture);
          if (mask >= 0) return 'mask' + mask;
          const definition = definitions.get(texture);
          if (
            definition?.method === 'createTexture2D' &&
            definition.args[0].bindFlags === 0x28 &&
            [28, 87].includes(definition.args[0].format)
          )
            return 'copy';
          throw Error('Unmapped native surface ' + id);
        };
        const legacySurface = (surface) =>
          surface === old.surface
            ? 'output'
            : legacyMasks.some((mask) => mask.surface === surface)
              ? 'mask' + legacyMasks.findIndex((mask) => mask.surface === surface)
              : surface && ![...legacySources.keys()].some((id) => images.get(id) === surface)
                ? 'copy'
                : 'unmapped';
        let legacyTarget = null;
        const legacyDrawTargets = [];
        for (const command of commands) {
          if (command.kind === 'gpu-target') legacyTarget = command.surface;
          else if (command.kind === 'triangles' && command.depthClip === false)
            legacyDrawTargets.push(legacySurface(legacyTarget));
        }
        const factor = {
          1: 'zero',
          2: 'one',
          3: 'source-color',
          4: 'inverse-source-color',
          5: 'source-alpha',
          6: 'inverse-source-alpha',
          7: 'destination-alpha',
          8: 'inverse-destination-alpha',
          9: 'destination-color',
          10: 'inverse-destination-color',
        };
        const operation = {1: 'add', 2: 'subtract', 3: 'reverse-subtract', 4: 'min', 5: 'max'};
        const channel = (op, src, dst) => ({
          operation: operation[op],
          source: factor[src],
          destination: factor[dst],
        });
        const nativeBlend = (desc) =>
          desc.blendEnable
            ? {
                color: channel(desc.blendOp, desc.srcBlend, desc.destBlend),
                alpha: channel(desc.blendOpAlpha, desc.srcBlendAlpha, desc.destBlendAlpha),
              }
            : {color: channel(1, 2, 1), alpha: channel(1, 2, 1)};
        let blend = null,
          targetId = null;
        const shaderViews = [],
          samplers = [];
        const buffers = new Map(),
          vsBuffers = [],
          psBuffers = [];
        let pixel = null,
          drawIndex = 0;
        const stateMappings = [];
        for (const call of calls) {
          if (call.method === 'omSetBlendState')
            blend = definitions.get(call.args[0].resource).args[0].renderTarget[0];
          else if (call.method === 'omSetRenderTargets') targetId = call.args[0][0]?.resource;
          else if (call.method === 'psSetShaderResources')
            call.args[1].forEach(
              (resource, i) => (shaderViews[call.args[0] + i] = resource?.resource ?? null),
            );
          else if (call.method === 'psSetSamplers')
            call.args[1].forEach(
              (resource, i) => (samplers[call.args[0] + i] = resource?.resource ?? null),
            );
          else if (call.method === 'updateSubresource')
            buffers.set(call.args[0].resource, call.args[3].hex);
          else if (
            call.method === 'vsSetConstantBuffers' ||
            call.method === 'psSetConstantBuffers'
          ) {
            const bindings = call.method === 'vsSetConstantBuffers' ? vsBuffers : psBuffers;
            call.args[1].forEach(
              (resource, i) => (bindings[call.args[0] + i] = resource?.resource ?? null),
            );
          } else if (call.method === 'psSetShader') pixel = definitions.get(call.args[0].resource);
          else if (call.method === 'draw') {
            const original = legacyMeshes[drawIndex++];
            const [family, k, a, masked, filter, fixup, formula, alphaTest] = programKeys
              .get(original.fragment)
              .split('/');
            const source = Number(k) * 12 + Number(a) + Number(masked);
            const expectedPixel =
              family === 'basic'
                ? source * 15 + Number(filter) + Number(fixup)
                : family === 'buffered'
                  ? 900 + source * 19 + Number(formula)
                  : 2042 +
                    (Number(k) * 2 + Number(alphaTest)) * 3 +
                    (original.blendState.alpha.source === 'zero' ? 2 : Number(masked));
            const expectedNativeMatrix = nativeMatrixOf(original.transform);
            const transform = hex(new Uint8Array(expectedNativeMatrix.buffer));
            const actualTransform = buffers.get(vsBuffers[0]);
            const constants = [];
            for (const buffer of fixture.pixelReflection[pixel.index].buffers) {
              const data = buffers.get(psBuffers[buffer.slot]);
              for (const variable of buffer.variables) {
                let expected;
                if (variable.name === 'screenMul')
                  expected = Float32Array.of(1 / width, 1 / height);
                else if (variable.name === 'screenMulOffset')
                  expected = original.parameters.subarray(4, 8);
                else if (
                  variable.name === 'alphaMulAdd' ||
                  variable.name === 'filterColor' ||
                  variable.name === 'blendParam'
                )
                  expected = original.parameters.subarray(0, variable.bytes / 4);
                else throw Error('Unmapped native constant ' + variable.name);
                const bytes = hex(
                  new Uint8Array(expected.buffer, expected.byteOffset, expected.byteLength),
                );
                const actual = data?.slice(
                  variable.offset * 2,
                  (variable.offset + variable.bytes) * 2,
                );
                constants.push({
                  name: variable.name,
                  expected: bytes,
                  actual,
                  exact: bytes === actual,
                });
              }
            }
            const sourceExact =
              (legacySources.get(original.texture) ?? 0) ===
              (shaderViews[0] === null ? 0 : (nativeSources.get(shaderViews[0]) ?? -1));
            const actualTarget = nativeSurface(targetId),
              expectedTarget = legacyDrawTargets[drawIndex - 1];
            const expectedBlend = original.blendState,
              actualBlend = nativeBlend(blend);
            const sampler = definitions.get(samplers[0]).args[0];
            const samplingExact =
              sampler.filter === (original.filter === 'linear' ? 21 : 0) &&
              sampler.addressU === 3 &&
              sampler.addressV === 3;
            const extrasExact = (original.additionalTextures ?? []).every((extra, i) => {
              const expected = legacySurface(images.get(extra.texture));
              const actual = nativeSurface(shaderViews[Number(masked) && i === 0 ? 1 : 2]);
              const slot = Number(masked) && i === 0 ? 1 : 2,
                sampler = definitions.get(samplers[slot]).args[0];
              return (
                expected === actual &&
                sampler.filter === 0 &&
                sampler.addressU === 3 &&
                sampler.addressV === 3
              );
            });
            stateMappings.push({
              sourceExact,
              targetExact: actualTarget === expectedTarget,
              samplingExact,
              extrasExact,
              blendExact:
                blend.renderTargetWriteMask === 15 &&
                JSON.stringify(actualBlend) === JSON.stringify(expectedBlend),
              actualBlend,
              expectedBlend,
              legacyProgram: programKeys.get(original.fragment),
              nativePixelIndex: pixel.index,
              expectedPixelIndex: expectedPixel,
              shaderExact: pixel.index === expectedPixel,
              transformExact: actualTransform === transform,
              constants,
            });
          }
        }
        const mappedShaderConstantsExact =
          stateMappings.length === legacyMeshes.length &&
          stateMappings.every(
            (state) =>
              state.shaderExact &&
              state.transformExact &&
              state.constants.every((constant) => constant.exact),
          );
        const mappedStateExact =
          mappedShaderConstantsExact &&
          stateMappings.every(
            (state) =>
              state.sourceExact &&
              state.targetExact &&
              state.samplingExact &&
              state.extrasExact &&
              state.blendExact,
          );
        ctx.copyResource(staging, output);
        const mapped = ctx.map(staging, 0, 1, 0);
        if (mapped.hr !== 0) throw Error('Map ' + mapped.hr);
        const actual = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++)
          actual.set(
            mapped.value.data.subarray(
              y * mapped.value.rowPitch,
              y * mapped.value.rowPitch + width * 4,
            ),
            y * width * 4,
          );
        ctx.unmap(staging, 0);
        const differingPixels = [];
        let differences = 0,
          first = -1,
          maxDelta = 0;
        for (let i = 0; i < expected.length; i++)
          if (actual[i] !== expected[i]) {
            differences++;
            if (
              differingPixels.length < 24 &&
              (differingPixels.length === 0 || differingPixels.at(-1).pixel !== i >> 2)
            )
              differingPixels.push({
                pixel: i >> 2,
                x: (i >> 2) % width,
                y: Math.floor((i >> 2) / width),
                expected: [...expected.subarray(i & ~3, (i & ~3) + 4)],
                actual: [...actual.subarray(i & ~3, (i & ~3) + 4)],
              });
            if (first < 0) first = i;
            maxDelta = Math.max(maxDelta, Math.abs(actual[i] - expected[i]));
          }
        compared += expected.length;
        rows.push({
          name: test.name,
          passed: !differences && mappedVerticesExact && mappedTopologiesExact && mappedStateExact,
          mappedVerticesExact,
          mappedTopologiesExact,
          mappedShaderConstantsExact,
          mappedStateExact,
          stateMappings,
          nativeCalls: calls,
          nativePackedMeshes: meshBuffers.map(hex),
          mappedVertexSha256: await hash(
            new Uint8Array(logicalMeshes.flatMap((bytes) => [...bytes])),
          ),
          bytes: expected.length,
          differences,
          maxDelta,
          differingPixels,
          expectedSha256: await hash(expected),
          actualSha256: await hash(actual),
          ...(first < 0
            ? {}
            : {first: {offset: first, expected: expected[first], actual: actual[first]}}),
        });
      } catch (error) {
        recording = false;
        rows.push({name: test.name, passed: false, error: error.stack});
      }
    }
    // With opaque source alpha, buffered addition equals fixed-function additive
    // blending over generated color bands. The reference issues no destination
    // copy and never calls project(). Literal boxes enclose the affine rectangle.
    const readNative = () => {
      ctx.copyResource(staging, output);
      const mapped = ctx.map(staging, 0, 1, 0);
      if (mapped.hr !== 0) throw Error('Map ' + mapped.hr);
      const bytes = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++)
        bytes.set(
          mapped.value.data.subarray(
            y * mapped.value.rowPitch,
            y * mapped.value.rowPitch + width * 4,
          ),
          y * width * 4,
        );
      ctx.unmap(staging, 0);
      return bytes;
    };
    for (const [name, transform, expectedBox] of transforms) {
      try {
        const nativeMatrix = nativeMatrixOf(transform),
          background = item({
            grid: grid(1, 1, [-100, -100, 100, 100]),
            attr: 4,
            colors: solid(0x102030ff),
          }),
          body = item({
            grid: grid(1, 1, [-4, -3, 4, 3]),
            attr: 4,
            bm: 0x100,
            colors: solid(0x203040ff),
          });
        const backgrounds = [
          background,
          ...[
            [-4, -3, 0x104080ff],
            [-2, 2, 0x204010ff],
            [3, 4, 0x404010ff],
          ].map(([left, right, color]) =>
            item({grid: grid(1, 1, [left, -100, right, 100]), attr: 4, colors: solid(color)}),
          ),
        ];
        ctx.clearRenderTargetView(view, [0, 0, 0, 0]);
        recording = true;
        calls = [];
        meshBuffers = [];
        native.render([...backgrounds, body], nativeOutput.binding, nativeMatrix, false);
        recording = false;
        const actual = readNative(),
          nativeCalls = calls;
        ctx.clearRenderTargetView(view, [0, 0, 0, 0]);
        native.render(
          [...backgrounds, {...body, bm: 1}],
          nativeOutput.binding,
          nativeMatrix,
          false,
        );
        const expected = readNative();
        compared += actual.length;
        const differences = actual.reduce((n, b, i) => n + (b !== expected[i]), 0);
        const copyCall = nativeCalls.find((call) => call.method === 'copySubresourceRegion'),
          box = copyCall?.args.at(-1),
          actualBox = box ? [box.left, box.top, box.right, box.bottom] : null,
          copyBoundsExact = JSON.stringify(actualBox) === JSON.stringify(expectedBox);
        rows.push({
          name: 'native-projected-copy-' + name,
          scope:
            'generated native buffered-addition/fixed-function-addition relation and literal copy bounds',
          passed: !differences && copyBoundsExact,
          expectedBox,
          actualBox,
          copyBoundsExact,
          differences,
          bytes: actual.length,
          expectedSha256: await hash(expected),
          actualSha256: await hash(actual),
          nativeCalls,
        });
      } catch (error) {
        recording = false;
        rows.push({name: 'native-projected-copy-' + name, passed: false, error: error.stack});
      }
    }
    // Exercise actual device-matrix preparation through the native shader bank,
    // comparing asymmetric generated geometry with literal register matrices.
    for (const mode of [0, 1, 'manual']) {
      try {
        const matrices = new EmoteD3d11Matrices();
        let expectedMatrix;
        if (mode === 'manual') {
          matrices.setAutomaticMatrix(false);
          matrices.setWorldMatrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 2, 0, 1]);
          matrices.setViewMatrix([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
          matrices.setProjectionMatrix([
            2 / width,
            0,
            0,
            0,
            0,
            -2 / height,
            0,
            0,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            1,
          ]);
          expectedMatrix = Float32Array.of(
            0,
            -1 / 16,
            0,
            -1 / 8,
            -1 / 12,
            0,
            0,
            -1 / 4,
            0,
            0,
            1,
            0,
            0,
            0,
            0,
            1,
          );
        } else {
          expectedMatrix = Float32Array.of(
            1 / 16,
            0,
            0,
            -0,
            0,
            (mode === 0 ? 1 : -1) / 12,
            0,
            -0,
            0,
            0,
            mode === 0 ? -0.1 : 0.1,
            -0.9,
            0,
            0,
            0,
            1,
          );
        }
        const actualMatrix = matrices.shaderMatrix(width, height, mode === 'manual' ? 1 : mode),
          matrixWordsExact =
            hex(new Uint8Array(actualMatrix.buffer)) === hex(new Uint8Array(expectedMatrix.buffer)),
          body = item({
            grid: grid(1, 1, [1, 2, 7, 5]),
            attr: 4,
            colors: Uint32Array.of(0x204060ff, 0x604020ff, 0x406020ff, 0x206040ff),
          });
        const read = () => {
          ctx.copyResource(staging, output);
          const mapped = ctx.map(staging, 0, 1, 0);
          if (mapped.hr !== 0) throw Error('Map ' + mapped.hr);
          const bytes = new Uint8Array(width * height * 4);
          for (let y = 0; y < height; y++)
            bytes.set(
              mapped.value.data.subarray(
                y * mapped.value.rowPitch,
                y * mapped.value.rowPitch + width * 4,
              ),
              y * width * 4,
            );
          ctx.unmap(staging, 0);
          return bytes;
        };
        ctx.clearRenderTargetView(view, [0, 0, 0, 0]);
        recording = true;
        calls = [];
        meshBuffers = [];
        native.render([body], nativeOutput.binding, actualMatrix, false);
        recording = false;
        const actual = read(),
          nativeCalls = calls;
        ctx.clearRenderTargetView(view, [0, 0, 0, 0]);
        native.render([body], nativeOutput.binding, expectedMatrix, false);
        const expected = read(),
          differences = actual.reduce((n, b, i) => n + (b !== expected[i]), 0),
          nonzeroBytes = actual.reduce((n, b) => n + (b !== 0), 0);
        compared += actual.length;
        rows.push({
          name: 'native-device-matrices-' + mode,
          scope:
            'actual matrix owner and native GPU path vs literal register words on asymmetric generated geometry',
          passed: matrixWordsExact && differences === 0 && nonzeroBytes > 0,
          matrixWordsExact,
          actualMatrix: hex(new Uint8Array(actualMatrix.buffer)),
          expectedMatrix: hex(new Uint8Array(expectedMatrix.buffer)),
          differences,
          nonzeroBytes,
          expectedSha256: await hash(expected),
          actualSha256: await hash(actual),
          nativeCalls,
        });
      } catch (error) {
        recording = false;
        rows.push({name: 'native-device-matrices-' + mode, passed: false, error: error.stack});
      }
    }
  } finally {
    old.close();
    cache.close();
    target.dispose();
    native.dispose();
    nativeOutput.dispose();
    bank.dispose();
    textures.dispose();
    for (const object of objects.reverse()) object.release();
    ctx.release();
    device.release();
    loader.dispose();
  }
  rows.push({
    name: 'final-device-retired',
    passed: device.queryInterface('db6f6ddb-ac77-4e88-8253-819df9bbf140').value === null,
  });
  const failures = rows.filter((row) => !row.passed);
  return {
    available: true,
    cases: rows.length,
    failed: failures.length,
    failures,
    rows,
    numericBytesCompared: compared,
    nativeResourceDefinitions: resourceDefinitions,
    generatedTexturesAndGeometry: true,
    gamePixels: false,
    screenshots: false,
    nativeCpuInstructionsExecuted: false,
    nativeShaderSemanticsExecuted: true,
    fullRenderCommandComparison: false,
    performanceAcceptanceComplete: false,
  };
}

if (process.argv.includes('--help'))
  console.log(
    'Usage: node tools/probe-emote-d3d11-renderer.mjs --driver exact-driver.dll --reference-dist saved-original-dist [--browser path] [--output new-results.json]',
  );
else
  try {
    const root = new URL('../', import.meta.url),
      args = process.argv.slice(2),
      driverAt = args.indexOf('--driver');
    if (driverAt < 0 || !args[driverAt + 1])
      throw Error('--driver requires an exact native DLL image');
    const driver = resolve(args.splice(driverAt, 2)[1]);
    const referenceAt = args.indexOf('--reference-dist');
    if (referenceAt < 0 || !args[referenceAt + 1])
      throw Error('--reference-dist requires an external saved-original compiled runtime');
    const reference = resolve(args.splice(referenceAt, 2)[1]),
      referencePaths = (await readdir(reference, {recursive: true}))
        .filter((p) => p.endsWith('.js'))
        .sort(),
      modules = new Map(),
      referenceFiles = [];
    if (!referencePaths.includes('native/emotedriver/renderer.js'))
      throw Error('Saved-original renderer is missing');
    for (const path of referencePaths) {
      const absolute = join(reference, path),
        bytes = await readFile(absolute);
      referenceFiles.push({
        path: absolute,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      modules.set('/reference/' + path, bytes.toString('utf8'));
    }
    const paths = [
      driver,
      'tools/probe-emote-d3d11-renderer.mjs',
      'tools/lib/synthetic-browser-probe.mjs',
      'src/native/emotedriver/runtime/render/renderer-d3d11.ts',
      'src/native/emotedriver/runtime/render/d3d11-target.ts',
      'src/native/emotedriver/runtime/render/d3d11-matrices.ts',
      'src/native/emotedriver/contract.ts',
      'src/graphics/webgl-draw.ts',
      'tests/d3d11-library.test.mjs',
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
      modules,
      name: 'vn-emote-d3d11-renderer',
    });
    for (const f of [...files, ...referenceFiles])
      if (
        createHash('sha256')
          .update(await readFile(f.path))
          .digest('hex') !== f.sha256
      )
        throw Error('Source/dist changed during public device probe: ' + f.path);
    if (
      JSON.stringify(referencePaths) !==
      JSON.stringify(
        (await readdir(reference, {recursive: true})).filter((p) => p.endsWith('.js')).sort(),
      )
    )
      throw Error('Saved-original reference file set changed during probe');
    if (JSON.stringify(dist) !== JSON.stringify(await distFiles()))
      throw Error('Complete compiled dist file set changed during public device probe');
    await writeFile(
      result.outputPath,
      JSON.stringify(
        {
          ...result,
          files,
          fullDistFileCount: dist.length,
          referenceFiles,
          referenceDist: reference,
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
      JSON.stringify({
        cases: result.cases,
        failed: result.failed,
        failures: result.failures?.map(({name, differences, error, mappedVerticesExact}) => ({
          name,
          differences,
          error,
          mappedVerticesExact,
        })),
      }),
    );
    if (!result.available || result.failed) process.exitCode = 1;
  } catch (error) {
    console.error(error.stack);
    process.exitCode = 1;
  }
