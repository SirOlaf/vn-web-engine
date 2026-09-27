import {resolve} from 'node:path';
import {
  parseSyntheticBrowserOptions,
  runSyntheticBrowserProbe,
} from './lib/synthetic-browser-probe.mjs';

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
  const [
    {BurikoBpThread, pop32},
    {BurikoBitmapCompositor},
    {BurikoNativeClock},
    {BurikoDisplayDamage},
    {BurikoDisplayManager},
    {BurikoDisplayObjectEnvironment},
    {BurikoNativeDisplayState},
    {BurikoDistributedAllocator},
    {BurikoNativeFonts},
    {BurikoNativeInput},
    {BurikoProcedureState},
    {BurikoSurfaces},
    {BurikoNativeText},
    {BurikoCoordinateSplineControlProcess},
    {setRuntimeProfile},
    runtimePerformance,
  ] = await Promise.all([
    import('/runtime/engines/buriko/bp/state.js'),
    import('/runtime/engines/buriko/native/bitmap-compositor.js'),
    import('/runtime/engines/buriko/native/clock.js'),
    import('/runtime/engines/buriko/native/display-damage.js'),
    import('/runtime/engines/buriko/native/display-manager.js'),
    import('/runtime/engines/buriko/native/display-object.js'),
    import('/runtime/engines/buriko/native/display-state.js'),
    import('/runtime/engines/buriko/native/distributed-processing.js'),
    import('/runtime/engines/buriko/native/fonts.js'),
    import('/runtime/engines/buriko/native/input.js'),
    import('/runtime/engines/buriko/native/procedure.js'),
    import('/runtime/engines/buriko/native/surfaces.js'),
    import('/runtime/engines/buriko/native/text.js'),
    import('/runtime/engines/buriko/native/display-coordinate-spline-process.js'),
    import('/runtime/platform/runtime-profile.js'),
    import('/runtime/platform/runtime-performance.js'),
  ]);
  const width = options.smoke ? 65 : 2790,
    height = options.smoke ? 49 : 2056,
    ticks = [33, 66, 100, 133, 166, 200],
    profiles = ['native', 'browser-optimized'];
  const round = (value) => Math.round(value * 100) / 100;
  const hashBitmap = (bitmap) => {
    if (!bitmap?.storage) return null;
    let value = 2166136261;
    const {bytes} = bitmap.storage;
    for (let index = bitmap.offset; index < bitmap.offset + bitmap.stride * bitmap.height; index++)
      value = Math.imul(value ^ bytes[index], 16777619);
    return (value >>> 0).toString(16).padStart(8, '0');
  };
  const aggregate = (snapshot, name) =>
    snapshot.aggregates.find((entry) => entry.name === name)?.count ?? 0;

  async function runProfile(profile) {
    setRuntimeProfile(profile);
    const samples = ticks.map(() => []),
      hashes = [],
      states = [],
      stackResults = [],
      counts = {mix: 0, deferred: 0, flush: 0, reusedDestination: 0};
    for (let iteration = 0; iteration < options.iterations; iteration++) {
      let now = 0;
      const clock = new BurikoNativeClock(() => now),
        text = new BurikoNativeText(),
        fonts = new BurikoNativeFonts(text),
        compositor = new BurikoBitmapCompositor(),
        surfaces = new BurikoSurfaces(fonts, compositor, new BurikoDistributedAllocator(1)),
        environment = new BurikoDisplayObjectEnvironment(
          compositor,
          new BurikoDisplayDamage(16, {left: 0, top: 0, right: width - 1, bottom: height - 1}),
        ),
        display = new BurikoNativeDisplayState(width, height),
        manager = new BurikoDisplayManager(environment, surfaces, display),
        input = new BurikoNativeInput(display, clock),
        procedures = new BurikoProcedureState(),
        thread = new BurikoBpThread({
          id: 1,
          operandCapacity: 32,
          moduleCapacity: 0,
          frameCapacity: 0,
        }),
        handle = manager.createSprite(),
        sprite = manager.resolve(handle);
      if (!sprite) throw new Error('Synthetic display manager failed to create a sprite');

      const initializeSurface = (slot, seed) => {
        if (surfaces.allocate(slot, width, height, 2) === 0)
          throw new Error('Synthetic surface allocation failed');
        const bitmap = surfaces.descriptor(slot),
          bytes = bitmap?.storage?.bytes;
        if (!bitmap?.storage || !bytes) throw new Error('Synthetic surface has no storage');
        let state = seed;
        for (let index = 0; index < bytes.length; index++) {
          state ^= state << 13;
          state ^= state >>> 17;
          state ^= state << 5;
          bytes[index] = state & 255;
          if ((index & 3) === 3) bytes[index] = (index >>> 2) % 9 < 7 ? 255 : 96;
        }
        bitmap.storage.written(0, bytes.length);
      };
      initializeSurface(1, 0x12345678);
      initializeSurface(2, 0x87654321);
      const configured = sprite.configureAffineBlend({
        sourceSurface: 1,
        secondarySurface: 2,
        mixValue: 256,
        blendSelector: 1,
        pivotX: width >>> 1,
        pivotY: height >>> 1,
        angle: 0,
        perspective: 0,
        pivotPolicy: 0,
        sampling: 1,
      });
      if (configured !== 0)
        throw new Error('Synthetic affine blend configuration failed: ' + configured);

      const pathBytes = new Uint8Array(16),
        pathView = new DataView(pathBytes.buffer);
      pathView.setInt32(0, 120 << 16, true);
      pathView.setInt32(4, 80 << 16, true);
      pathView.setInt32(8, 24 << 16, true);
      pathView.setUint32(12, 0x13579bdf, true);
      const process = new BurikoCoordinateSplineControlProcess(
        thread,
        procedures,
        clock,
        manager,
        input,
        handle,
        () => {
          throw new Error('Synthetic sprite disappeared during control');
        },
      );
      const initialized = process.initializeCoordinates(
        1,
        {bytes: pathBytes, offset: 0},
        0,
        0,
        0,
        20,
        200,
        30,
        0,
      );
      if (initialized !== 0) throw new Error('Synthetic coordinate spline initialization failed');

      try {
        for (let step = 0; step < ticks.length; step++) {
          now = ticks[step];
          runtimePerformance.startRuntimePerformanceRecording();
          const started = performance.now();
          const result = process.poll();
          const elapsed = performance.now() - started;
          runtimePerformance.stopRuntimePerformanceRecording();
          if (typeof result !== 'number')
            throw new Error('Synthetic control poll unexpectedly yielded');
          const snapshot = runtimePerformance.getRuntimePerformanceSnapshot();
          counts.mix += aggregate(snapshot, 'buriko.sprite.mix');
          counts.deferred += aggregate(snapshot, 'buriko.sprite.mix.deferred');
          counts.flush += aggregate(snapshot, 'buriko.sprite.mix.batch-flush');
          counts.reusedDestination += aggregate(snapshot, 'buriko.sprite.mix.reused-destination');
          samples[step].push(elapsed);
          const state = {
            coordinates: sprite.coordinates(),
            position: sprite.position(),
            blend: sprite.getBlendValue(),
            depth: sprite.getValueD8(1),
            pollResult: result,
            mixedHash: hashBitmap(sprite.mixedBitmap),
          };
          hashes.push(state.mixedHash);
          states.push(state);
          if (result === 1) stackResults.push([pop32(thread), pop32(thread)]);
          else stackResults.push(null);
        }
      } finally {
        manager.dispose();
        surfaces.release(1);
        surfaces.release(2);
      }
    }
    return {
      profile,
      ticksMs: ticks,
      pollMedianMs: samples.map((row) => {
        const sorted = [...row].sort((a, b) => a - b);
        return round(sorted[sorted.length >> 1]);
      }),
      pollSamplesMs: samples.map((row) => row.map(round)),
      counts,
      hashes,
      states,
      stackResults,
    };
  }

  try {
    const native = await runProfile(profiles[0]),
      optimized = await runProfile(profiles[1]);
    if (
      JSON.stringify(native.hashes) !== JSON.stringify(optimized.hashes) ||
      JSON.stringify(native.states) !== JSON.stringify(optimized.states) ||
      JSON.stringify(native.stackResults) !== JSON.stringify(optimized.stackResults)
    )
      throw new Error('Native and browser-optimized sprite-control outputs differ');
    return {
      available: true,
      synthetic: true,
      width,
      height,
      iterations: options.iterations,
      profiles: [native, optimized].map(({states, hashes, stackResults, ...profile}) => profile),
      parity: {hashes: native.hashes, states: native.states, stackResults: native.stackResults},
    };
  } finally {
    setRuntimeProfile('native');
  }
}

const result = await runSyntheticBrowserProbe({
  options,
  pageMain,
  runtimeRoot,
  name: 'vn-buriko-sprite-control',
});
console.log(JSON.stringify(result, null, 2));
