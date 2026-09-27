import {resolve} from 'node:path';
import {
  parseSyntheticBrowserOptions,
  runSyntheticBrowserProbe,
} from './lib/synthetic-browser-probe.mjs';

// Generated buffers only. This exercises RGBA composition and post-decode
// surface/preload registration without loading a game or presenting pixels.
const args = process.argv.slice(2);
let runtimeRoot = resolve('dist');
const rootIndex = args.indexOf('--runtime-root');
if (rootIndex !== -1) {
  if (!args[rootIndex + 1] || args[rootIndex + 1].startsWith('--'))
    throw new Error('--runtime-root requires a compiled runtime directory');
  runtimeRoot = resolve(args[rootIndex + 1]);
  args.splice(rootIndex, 2);
}
const options = parseSyntheticBrowserOptions(args);

async function pageMain(_fixture, options) {
  const load = (name) => import('/runtime/engines/buriko/native/' + name + '.js');
  const [bitmap, alpha, image, surface, compositor, distributed, text, preload] = await Promise.all(
    [
      'bitmap',
      'bitmap-alpha',
      'bitmap-image',
      'surfaces',
      'bitmap-compositor',
      'distributed-processing',
      'text',
      'bitmap-preload-cache',
    ].map(load),
  );
  const width = options.smoke ? 257 : 2790,
    height = options.smoke ? 131 : 2056,
    packed = new Uint8Array(16 + width * height * 4),
    header = new DataView(packed.buffer);
  header.setUint16(0, width, true);
  header.setUint16(2, height, true);
  header.setUint16(4, 32, true);
  let state = 0x456;
  for (let i = 16; i < packed.length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    packed[i] = state & 255;
  }
  const initialized = new Uint8Array(packed.length).fill(1),
    pixels = packed.subarray(16),
    nativeText = new text.BurikoNativeText(),
    cache = new preload.BurikoBitmapPreloadCache(nativeText),
    name = nativeText.encodeWide('synthetic', 1),
    surfaces = new surface.BurikoSurfaces(
      null,
      new compositor.BurikoBitmapCompositor(),
      new distributed.BurikoDistributedAllocator(1),
    );
  const descriptor = (bytes) => ({
    storage: new bitmap.BurikoBitmapStorage(bytes, true),
    offset: 0,
    stride: width * 4,
    width,
    height,
    format: 2,
    bytesPerPixel: 4,
  });
  const source = descriptor(pixels),
    destination = descriptor(pixels.slice());
  const hash = (bytes) => {
    let value = 2166136261;
    for (const byte of bytes) value = Math.imul(value ^ byte, 16777619);
    return (value >>> 0).toString(16).padStart(8, '0');
  };
  const measure = async (name, prepare, run, read, cleanup = () => {}) => {
    const times = [];
    let coldMs, outputHash;
    for (let pass = 0; pass < options.iterations + 3; pass++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      prepare();
      const start = performance.now();
      run();
      const elapsed = performance.now() - start;
      if (pass === 0) {
        coldMs = elapsed;
        outputHash = hash(read());
      }
      if (pass >= 3) times.push(elapsed);
      cleanup();
    }
    times.sort((a, b) => a - b);
    const round = (value) => Math.round(value * 100) / 100;
    return {
      name,
      hash: outputHash,
      coldMs: round(coldMs),
      medianMs: round(times[times.length >> 1]),
      samplesMs: times.map(round),
    };
  };
  const results = [];
  for (const weight of [null, 78])
    results.push(
      await measure(
        weight === null ? 'RGBA normal composition' : 'RGBA transparent composition (78)',
        () => destination.storage.bytes.set(pixels),
        () =>
          weight === null
            ? alpha.blendBurikoAlpha(destination, source)
            : alpha.blendBurikoAlphaWithTransparency(destination, source, weight),
        () => destination.storage.bytes,
      ),
    );
  results.push(
    await measure(
      'Decoded bitmap import and preload',
      () => {},
      () => {
        image.importBurikoPackedBitmap(surfaces, 0, packed, initialized);
        cache.insertPointer(null, name, {bytes: packed, offset: 0, initialized}, packed.length);
      },
      () => surfaces.snapshot(0).storage.bytes,
      () => {
        surfaces.release(0);
        cache.clear();
      },
    ),
  );
  return {available: true, synthetic: true, width, height, results};
}

const result = await runSyntheticBrowserProbe({
  options,
  pageMain,
  runtimeRoot,
  name: 'vn-buriko-bitmap-setup',
});
console.log(JSON.stringify({synthetic: true, results: result.results}, null, 2));
