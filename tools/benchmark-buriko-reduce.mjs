import {resolve} from 'node:path';
import {
  parseSyntheticBrowserOptions,
  runSyntheticBrowserProbe,
} from './lib/synthetic-browser-probe.mjs';

// Each timing includes fresh native bitmap allocations, input/output staging,
// checked validity updates and all four mipmap levels. No game files are served.
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
  const {allocateBurikoBitmap, BurikoBitmapStorage} =
    await import('/runtime/engines/buriko/native/bitmap.js');
  const {reduceBurikoBitmapHalf} = await import('/runtime/engines/buriko/native/bitmap-reduce.js');
  const cases = options.smoke
    ? [[129, 131]]
    : [
        [2790, 2056],
        [1279, 719],
      ];
  const hash = (bytes) => {
    let value = 2166136261;
    for (const byte of bytes) value = Math.imul(value ^ byte, 16777619);
    return (value >>> 0).toString(16).padStart(8, '0');
  };
  const results = [];
  for (const [width, height] of cases) {
    const storage = new BurikoBitmapStorage(new Uint8Array(width * height * 4), true);
    let state = 456;
    for (let index = 0; index < storage.bytes.length; index++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      storage.bytes[index] = state & 255;
    }
    const source = {
      storage,
      offset: 0,
      stride: width * 4,
      width,
      height,
      format: 2,
      bytesPerPixel: 4,
    };
    const times = [];
    let coldMs = 0,
      hashes = [];
    for (let pass = 0; pass < options.iterations + 3; pass++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      const start = performance.now();
      const chain = [];
      let previous = source;
      for (let level = 0; level < 4; level++) {
        const next = allocateBurikoBitmap(
          (previous.width + 1) >>> 1,
          (previous.height + 1) >>> 1,
          previous.format,
        );
        reduceBurikoBitmapHalf(next, previous);
        chain.push(next);
        previous = next;
      }
      const elapsed = performance.now() - start;
      if (pass === 0) {
        coldMs = elapsed;
        hashes = chain.map(({storage}) => hash(storage.bytes));
      }
      if (pass >= 3) times.push(elapsed);
      for (const bitmap of chain) bitmap.storage.release();
    }
    const round = (value) => Math.round(value * 100) / 100;
    times.sort((a, b) => a - b);
    results.push({
      width,
      height,
      levels: 4,
      hashes,
      coldMs: round(coldMs),
      medianMs: round(times[times.length >> 1]),
      maxMs: round(times.at(-1)),
      samplesMs: times.map(round),
    });
  }
  return {available: true, synthetic: true, results};
}

const result = await runSyntheticBrowserProbe({
  options,
  pageMain,
  runtimeRoot,
  name: 'vn-buriko-reduce',
});
console.log(JSON.stringify({synthetic: true, results: result.results}, null, 2));
