import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Synthetic buffers only: no game files, DOM, canvas, audio, or rendered assets.
// Optional arguments: baseline dist directory (with an ESM package.json above it), name filter.
const current = new URL('../dist/', import.meta.url);
const roots = process.argv[2]
  ? [pathToFileURL(resolve(process.argv[2]) + '/'), current]
  : [current];
const modules = await Promise.all(
  roots.map(async (root) => {
    const native = new URL('engines/buriko/native/', root);
    const imports = await Promise.all(
      [
        'bitmap',
        'bitmap-alpha',
        'bitmap-mix',
        'bitmap-copy',
        'display-device',
        'display-texture',
        'surfaces',
        'bitmap-compositor',
        'distributed-processing',
      ].map((name) => import(new URL(`${name}.js`, native))),
    );
    return Object.assign(
      {},
      ...imports,
      await import(new URL('audio/ogg-vorbis.js', native)),
      await import(new URL('engines/buriko/bp/decode.js', root)),
      await import(new URL('engines/buriko/bp/memory.js', root)),
      await import(new URL('engines/buriko/bp/opcodes/operands.js', root)),
    );
  }),
);

function populate(bytes, seed) {
  let state = seed;
  for (let i = 0; i < bytes.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[i] = state & 255;
  }
}

function bitmap(lib, seed, format = 2) {
  const storage = new lib.BurikoBitmapStorage(new Uint8Array(1280 * 720 * 4), true);
  populate(storage.bytes, seed);
  return {storage, offset: 0, stride: 1280 * 4, width: 1280, height: 720, format, bytesPerPixel: 4};
}

function blend(lib, operation) {
  const output = bitmap(lib, 123, 1);
  const first = bitmap(lib, 456);
  const second = bitmap(lib, 789);
  return {
    run() {
      if (operation === 'fused') lib.blendMixedBurikoBitmapsIntoRgb(output, first, second, 127, 63);
      else if (operation === 'crossfade') lib.mixBurikoAllChannels(output, first, 127);
      else lib.blendBurikoAlphaIntoRgb(output, first);
      return output.storage.bytes;
    },
  };
}

function copyRows(lib, shared) {
  const pitch = shared ? 2048 * 4 : 1280 * 4;
  const input = new lib.BurikoBitmapStorage(new Uint8Array(pitch * 720 * (shared ? 2 : 1)), true);
  const output = shared ? input : new lib.BurikoBitmapStorage(new Uint8Array(pitch * 720), true);
  populate(input.bytes, 123);
  const source = {
    storage: input,
    offset: 0,
    stride: pitch,
    width: 1280,
    height: 720,
    format: 1,
    bytesPerPixel: 4,
  };
  const destination = {...source, storage: output, offset: shared ? pitch * 720 : 0};
  return {
    run() {
      lib.copyBurikoBitmapRows(destination, source);
      return output.bytes;
    },
  };
}

function copyRgbToAlpha(lib) {
  const source = bitmap(lib, 123, 1);
  const destination = {...source, format: 2};
  return {
    run() {
      destination.storage = new lib.BurikoBitmapStorage(new Uint8Array(1280 * 720 * 4), false);
      lib.copyBurikoRgbToAlpha(destination, source);
      return destination.storage.bytes;
    },
  };
}

function raster(lib, width, height) {
  const texture = new lib.BurikoDisplayTexture(2048, 1024, 21);
  populate(texture.storage.bytes, 123);
  // Supply the device's raster inputs directly; never construct a presentation sink.
  const device = Object.create(lib.BurikoDisplayDevice.prototype);
  device.manager = {displayState: {logicalWidth: 1280, logicalHeight: 720}};
  device.frame = {width, height, data: new Uint8ClampedArray(width * height * 4)};
  device.vertices = new Uint8Array(112);
  device.sampler = 'linear';
  const quad = new DataView(device.vertices.buffer);
  for (const [offset, x, y, u, v] of [
    [0, -0.5, -0.5, 0, 0],
    [28, width - 0.5, -0.5, 1280 / 2048, 0],
    [56, -0.5, height - 0.5, 0, 720 / 1024],
    [84, width - 0.5, height - 0.5, 1280 / 2048, 720 / 1024],
  ]) {
    quad.setFloat32(offset, x, true);
    quad.setFloat32(offset + 4, y, true);
    quad.setFloat32(offset + 20, u, true);
    quad.setFloat32(offset + 24, v, true);
  }
  return {
    device,
    texture,
    run() {
      device.rasterizeQuad(texture, false);
      return device.frame.data;
    },
  };
}

function prepare(lib, patchWidth, patchHeight, fullUpload) {
  const {device, texture} = raster(lib, 1280, 720);
  Object.assign(device, {
    source: texture,
    sampled: new lib.BurikoDisplayTexture(2048, 1024, 21),
    logicalDeviceReady: true,
    rasterValid: false,
    rasterVertices: new Uint8Array(112),
    shifted: 0,
    filterMode: 0,
  });
  device.prepare(1, null, 0, 0);
  const rectangle = {left: 64, top: 64, right: 63 + patchWidth, bottom: 63 + patchHeight};
  return {
    run() {
      for (let y = rectangle.top; y <= rectangle.bottom; y++)
        for (let x = rectangle.left; x <= rectangle.right; x++)
          texture.storage.bytes[y * texture.pitch + x * 4] ^= 0xff;
      device.prepare(1, fullUpload ? null : [rectangle], 0, 0);
      return device.frame.data;
    },
  };
}

function bytecode(lib) {
  const thread = {moduleMemory: Uint8Array.from({length: 256}, (_, i) => i), pc: 0};
  return {
    run() {
      let sum = 0;
      for (let i = 0; i < 2_000_000; i++) {
        thread.pc = i & 255;
        sum += lib.readU8(thread);
      }
      return sum;
    },
  };
}

function scalarMemory(lib) {
  const memory = new lib.BurikoBpMemory(new Uint8Array(4096));
  const thread = {moduleMemory: new Uint8Array(4096), frameMemory: new Uint8Array(4096)};
  const context = {memory, thread};
  return {
    run() {
      let sum = 0;
      for (let i = 0; i < 1_000_000; i++) {
        const address = ((i % 3) << 28) | ((i & 255) * 4 + 4),
          type = i % 3;
        lib.writeScalar(context, address, type, i);
        sum += lib.readScalar(context, address, type);
      }
      return sum;
    },
  };
}

function oggChecksum(lib) {
  const page = new Uint8Array(65_307); // Maximum Ogg page, including its header and lacing table.
  populate(page, 456);
  return {
    run() {
      let sum = 0;
      for (let i = 0; i < 128; i++) sum += lib.burikoOggChecksum(page);
      return sum;
    },
  };
}

function importRgb(lib) {
  const bytes = new Uint8Array(1280 * 720 * 3);
  populate(bytes, 123);
  const surfaces = new lib.BurikoSurfaces(
    null,
    new lib.BurikoBitmapCompositor(),
    new lib.BurikoDistributedAllocator(1),
  );
  return {
    run() {
      surfaces.importRaw(1, 1280, 720, 1, {bytes, offset: 0});
      return surfaces.descriptor(1).storage.bytes;
    },
  };
}

const median = (values) => values.sort((a, b) => a - b)[values.length >> 1];
const results = [];
for (const [name, create] of [
  ['Alpha into RGB, 720p', (lib) => blend(lib, 'alpha')],
  ['All-channel crossfade, 720p', (lib) => blend(lib, 'crossfade')],
  ['Fused transition, 720p', (lib) => blend(lib, 'fused')],
  ['Ogg checksums, 128 maximum-size pages', oggChecksum],
  ['Import packed BGR24, 720p', importRgb],
  ['RGB to alpha, fresh 720p destination', copyRgbToAlpha],
  ['Bitmap copy, separate 720p buffers', (lib) => copyRows(lib, false)],
  ['Bitmap copy, disjoint strided spans in one allocation', (lib) => copyRows(lib, true)],
  ['Linear raster, 720p', (lib) => raster(lib, 1280, 720)],
  ['Linear raster, 720p to 1080p', (lib) => raster(lib, 1920, 1080)],
  ['Prepare, 96x24 change in full 720p upload', (lib) => prepare(lib, 96, 24, true)],
  ['Prepare, 96x24 dirty rectangle', (lib) => prepare(lib, 96, 24, false)],
  ['Bytecode reads, 2 million', bytecode],
  ['VM scalar read/write pairs, 1 million', scalarMemory],
]) {
  if (process.argv[3] && !new RegExp(process.argv[3], 'i').test(name)) continue;
  const fixtures = modules.map(create);
  const outputs = fixtures.map((fixture) => fixture.run());
  if (outputs.length === 2) assert.deepEqual(outputs[1], outputs[0], name);
  const times = fixtures.map(() => []);
  for (let pass = 0; pass < 10; pass++) {
    const order = fixtures.map((_, index) => index);
    if (pass & 1) order.reverse();
    for (const index of order) {
      const start = performance.now();
      fixtures[index].run();
      if (pass >= 3) times[index].push(performance.now() - start);
    }
  }
  const ms = times.map(median);
  results.push(
    ms.length === 2
      ? {
          name,
          beforeMs: +ms[0].toFixed(2),
          afterMs: +ms[1].toFixed(2),
          speedup: +(ms[0] / ms[1]).toFixed(2),
        }
      : {name, ms: +ms[0].toFixed(2)},
  );
}
console.log(JSON.stringify({node: process.version, synthetic: true, results}, null, 2));
