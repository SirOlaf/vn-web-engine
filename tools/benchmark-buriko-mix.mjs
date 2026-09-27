import {resolve} from 'node:path';
import {
  parseSyntheticBrowserOptions,
  runSyntheticBrowserProbe,
} from './lib/synthetic-browser-probe.mjs';

// Compare independent builds with --runtime-root. Only compiled JavaScript and
// generated numeric buffers are served; no game files or presentation sink exist.
const args = process.argv.slice(2);
const diagnosticsIndex = args.indexOf('--diagnostics');
const diagnostics = diagnosticsIndex !== -1;
if (diagnostics) args.splice(diagnosticsIndex, 1);
let runtimeRoot = resolve('dist');
const rootIndex = args.indexOf('--runtime-root');
if (rootIndex !== -1) {
  if (!args[rootIndex + 1] || args[rootIndex + 1].startsWith('--'))
    throw new Error('--runtime-root requires a compiled runtime directory');
  runtimeRoot = resolve(args[rootIndex + 1]);
  args.splice(rootIndex, 2);
}
const options = parseSyntheticBrowserOptions(args);

async function pageMain(fixture, options) {
  const {allocateBurikoBitmap, BurikoBitmapStorage} =
    await import('/runtime/engines/buriko/native/bitmap.js');
  const {mixBurikoBitmaps} = await import('/runtime/engines/buriko/native/bitmap-mix.js');
  const runtimePerformance = fixture.diagnostics
    ? await import('/runtime/platform/runtime-performance.js')
    : null;
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
  const phaseNames = [
    ['allocationMs', 'buriko.sprite.mix.allocate-destination', 'span'],
    ['stagingInMs', 'buriko.sprite.mix.wasm-stage-in', 'span'],
    ['kernelMs', 'buriko.sprite.mix.wasm-kernel', 'span'],
    ['stagingOutMs', 'buriko.sprite.mix.wasm-stage-out', 'span'],
    ['memoryGrowthMs', 'buriko.sprite.mix.wasm-memory-growth', 'span'],
    ['wasmApplied', 'buriko.sprite.mix.wasm-applied', 'metric'],
  ];
  const emptyPhases = () =>
    Object.fromEntries(phaseNames.map(([key]) => [key, {count: 0, total: 0, min: null, max: 0}]));
  const combinedPhases = emptyPhases();
  let diagnosticsBuildId = null;
  for (const coverage of ['random', 'opaque', 'transparent', 'binary', 'coverage']) {
    const first = create(456, coverage),
      second = create(789, coverage, 9),
      reusableOutput = create(123, 'random'),
      factors = [0, 78, 149, 256],
      times = factors.map(() => []),
      hashes = factors.map(() => null),
      coldMs = [],
      diagnosticPhases = factors.map(() => emptyPhases()),
      diagnosticHashes = factors.map(() => []);
    for (let pass = 0; pass < options.iterations + 3; pass++) {
      for (let index = 0; index < factors.length; index++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        const collectingDiagnostics = runtimePerformance !== null && pass >= 3;
        if (collectingDiagnostics) runtimePerformance.startRuntimePerformanceRecording();
        let output = reusableOutput;
        let elapsed;
        try {
          if (collectingDiagnostics) {
            const finishAllocation = runtimePerformance.beginRuntimeSpan(
              'buriko.sprite.mix.allocate-destination',
            );
            try {
              output = allocateBurikoBitmap(width, height, 2);
            } finally {
              finishAllocation?.();
            }
          }
          const start = performance.now();
          mixBurikoBitmaps(output, first, second, factors[index], null, 0);
          elapsed = performance.now() - start;
          if (pass === 0) hashes[index] = hash(output.storage.bytes);
          if (pass >= 3) {
            times[index].push(elapsed);
            if (collectingDiagnostics) diagnosticHashes[index].push(hash(output.storage.bytes));
          }
        } finally {
          if (collectingDiagnostics) runtimePerformance.stopRuntimePerformanceRecording();
        }
        if (pass === 0) coldMs.push(elapsed);
        if (collectingDiagnostics) {
          const snapshot = runtimePerformance.getRuntimePerformanceSnapshot(),
            sample = new Map(snapshot.aggregates.map((entry) => [entry.name, entry]));
          diagnosticsBuildId = snapshot.buildId;
          for (const [key, name, kind] of phaseNames) {
            const measured = sample.get(name),
              phase = diagnosticPhases[index][key],
              combined = combinedPhases[key];
            if (!measured || measured.kind !== kind) continue;
            phase.count += measured.count;
            phase.total += measured.total;
            phase.min = phase.min === null ? measured.min : Math.min(phase.min, measured.min);
            phase.max = Math.max(phase.max, measured.max);
            combined.count += measured.count;
            combined.total += measured.total;
            combined.min =
              combined.min === null ? measured.min : Math.min(combined.min, measured.min);
            combined.max = Math.max(combined.max, measured.max);
          }
        }
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
        ...(runtimePerformance === null
          ? {}
          : {
              diagnostics: {
                measuredHashes: diagnosticHashes[index],
                phases: Object.fromEntries(
                  Object.entries(diagnosticPhases[index]).map(([key, phase]) => [
                    key,
                    {
                      count: phase.count,
                      total: round(phase.total),
                      min: phase.min === null ? null : round(phase.min),
                      max: round(phase.max),
                    },
                  ]),
                ),
              },
            }),
      });
    }
  }
  return {
    available: true,
    synthetic: true,
    width,
    height,
    results,
    ...(runtimePerformance === null
      ? {}
      : {
          diagnostics: {
            buildId: diagnosticsBuildId,
            measurement:
              'Each sample records one measured mix call. Allocation is timed separately; inner stages are included in mix elapsed time. Recorder setup and snapshots are outside the mix timer.',
            phases: Object.fromEntries(
              Object.entries(combinedPhases).map(([key, phase]) => [
                key,
                {
                  count: phase.count,
                  total: round(phase.total),
                  min: phase.min === null ? null : round(phase.min),
                  max: round(phase.max),
                },
              ]),
            ),
          },
        }),
  };
}

const result = await runSyntheticBrowserProbe({
  options,
  fixture: {diagnostics},
  pageMain,
  runtimeRoot,
  name: 'vn-buriko-mix',
});
console.log(
  JSON.stringify(
    {
      synthetic: true,
      results: result.results,
      ...(result.diagnostics === undefined ? {} : {diagnostics: result.diagnostics}),
    },
    null,
    2,
  ),
);
