import {resolve} from 'node:path';
import {
  parseSyntheticBrowserOptions,
  runSyntheticBrowserProbe,
} from './lib/synthetic-browser-probe.mjs';

// Compare independent builds with --runtime-root. Only compiled JavaScript and
// generated numeric buffers are served; no game files or presentation sink exist.
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
  const {BurikoBitmapStorage} = await import('/runtime/engines/buriko/native/bitmap.js');
  const {mixBurikoBitmaps} = await import('/runtime/engines/buriko/native/bitmap-mix.js');
  const width = options.smoke ? 257 : 2790,
    height = options.smoke ? 257 : 2056;
  const create = (seed, coverage, displacement = 0) => {
    const storage = new BurikoBitmapStorage(new Uint8Array(width * height * 4), true);
    let state = seed;
    for (let index = 0; index < storage.bytes.length; index++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      storage.bytes[index] = state & 255;
    }
    if (coverage !== 'random') {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let alpha;
          if (coverage === 'opaque') alpha = 255;
          else if (coverage === 'transparent') alpha = 0;
          else if (coverage === 'binary') alpha = (x + y * 5 + displacement) % 17 < 9 ? 0 : 255;
          else {
            const edge = Math.min(
              x - width / 6 - displacement,
              (width * 5) / 6 + displacement - x,
              y - height / 8,
              (height * 7) / 8 - y,
            );
            alpha = Math.max(0, Math.min(255, Math.floor(edge * 16)));
          }
          storage.bytes[(y * width + x) * 4 + 3] = alpha;
        }
      }
    }
    return {storage, offset: 0, stride: width * 4, width, height, format: 2, bytesPerPixel: 4};
  };
  const hash = (bytes) => {
    let value = 2166136261;
    for (const byte of bytes) value = Math.imul(value ^ byte, 16777619);
    return (value >>> 0).toString(16).padStart(8, '0');
  };
  const results = [];
  const round = (value) => Math.round(value * 100) / 100;
  for (const coverage of ['random', 'opaque', 'transparent', 'binary', 'coverage']) {
    const first = create(456, coverage),
      second = create(789, coverage, 9),
      output = create(123, 'random'),
      factors = [0, 78, 149, 256],
      times = factors.map(() => []),
      hashes = factors.map(() => null),
      coldMs = [];
    for (let pass = 0; pass < options.iterations + 3; pass++) {
      for (let index = 0; index < factors.length; index++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const start = performance.now();
        mixBurikoBitmaps(output, first, second, factors[index], null, 0);
        const elapsed = performance.now() - start;
        if (pass === 0) {
          coldMs.push(elapsed);
          hashes[index] = hash(output.storage.bytes);
        }
        if (pass >= 3) times[index].push(elapsed);
      }
    }
    for (let index = 0; index < factors.length; index++) {
      const samples = times[index].sort((a, b) => a - b);
      results.push({
        coverage,
        factor: factors[index],
        hash: hashes[index],
        coldMs: round(coldMs[index]),
        medianMs: round(samples[samples.length >> 1]),
        maxMs: round(samples.at(-1)),
        samplesMs: samples.map(round),
      });
    }
  }
  return {available: true, synthetic: true, width, height, results};
}

const result = await runSyntheticBrowserProbe({
  options,
  pageMain,
  runtimeRoot,
  name: 'vn-buriko-mix',
});
console.log(JSON.stringify({synthetic: true, results: result.results}, null, 2));
