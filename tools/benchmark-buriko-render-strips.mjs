import {resolve} from 'node:path';
import {
  parseSyntheticBrowserOptions,
  runSyntheticBrowserProbe,
} from './lib/synthetic-browser-probe.mjs';

// Generated buffers only. Compare job sizes without a canvas or game assets.
const options = parseSyntheticBrowserOptions(process.argv.slice(2));

async function pageMain(_fixture, options) {
  const lib = Object.assign(
    {},
    ...(await Promise.all(
      [
        'bitmap',
        'bitmap-compositor',
        'distributed-processing',
        'display-damage',
        'display-object',
        'display-manager',
        'display-state',
        'display-renderer',
        'surfaces',
      ].map((name) => import(`/runtime/engines/buriko/native/${name}.js`)),
    )),
  );
  const {recordRasterText, rasterTextBitmap, readRasterText} =
    await import('/runtime/text/raster-text.js');
  const {setRuntimeProfile} = await import('/runtime/platform/runtime-profile.js');
  const width = options.smoke ? 320 : 1920,
    height = options.smoke ? 180 : 1080;
  const bounds = {left: 0, top: 0, right: width - 1, bottom: height - 1};
  const budgets = [6406, 16384, 65536, 262144, 6406];
  const profileFor = (index) => (index === budgets.length - 1 ? 'browser-optimized' : 'native');
  const populate = (bytes, seed) => {
    let state = seed;
    for (let index = 0; index < bytes.length; index++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      bytes[index] = state & 255;
    }
  };
  const hash = (bytes) => {
    let value = 2166136261;
    for (const byte of bytes) value = Math.imul(value ^ byte, 16777619);
    return (value >>> 0).toString(16).padStart(8, '0');
  };
  const difference = (first, second) => {
    let bytes = 0,
      maximum = 0;
    for (let index = 0; index < first.length; index++) {
      const delta = Math.abs(first[index] - second[index]);
      bytes += Number(delta !== 0);
      maximum = Math.max(maximum, delta);
    }
    return {bytes, maximum};
  };
  function create(shape, text) {
    const compositor = new lib.BurikoBitmapCompositor(),
      allocator = new lib.BurikoDistributedAllocator(3),
      environment = new lib.BurikoDisplayObjectEnvironment(
        compositor,
        new lib.BurikoDisplayDamage(32, bounds),
      ),
      surfaces = new lib.BurikoSurfaces(null, compositor, allocator),
      manager = new lib.BurikoDisplayManager(
        environment,
        surfaces,
        new lib.BurikoNativeDisplayState(width, height),
      ),
      output = {
        storage: new lib.BurikoBitmapStorage(new Uint8Array(width * height * 4), true),
        offset: 0,
        stride: width * 4,
        width,
        height,
        format: 1,
        bytesPerPixel: 4,
      };
    compositor.defaultFormat = 1;
    manager.bindDisplayContext({bitmap: output, bounds});
    manager.backdrop.resizeToDisplay();
    const processing = new lib.BurikoDistributedProcessing(allocator, 3),
      renderer = new lib.BurikoDisplayRenderer(manager, budgets[0], processing);
    for (const [slot, sourceWidth, sampling] of [
      [1, width, 1],
      [2, Math.floor(width * 0.523), 0],
      ...(text ? [[3, 120, 1]] : []),
    ]) {
      surfaces.allocate(slot, sourceWidth, slot === 3 ? 24 : height, 2);
      const source = surfaces.descriptor(slot);
      populate(source.storage.bytes, slot);
      source.storage.written(0, source.storage.bytes.length);
      if (slot === 3) recordRasterText(source, 'generated', {size: 24, width: 120});
      const sprite = manager.find('sprite', manager.createSprite());
      sprite.setCoordinates(
        (-(width >>> 1) << 16) + 0x8000,
        ((slot === 3 ? height - 48 - (height >>> 1) : -(height >>> 1)) << 16) + 0x8000,
        0,
      );
      const result = sprite.configureAffineBlend({
        sourceSurface: slot,
        pivotX: 0,
        pivotY: 0,
        angle: shape === 'rotation' && slot !== 3 ? 7 * 65536 : 0,
        perspective: 0,
        pivotPolicy: 0,
        sampling,
      });
      if (result !== 0) throw new Error('Synthetic sprite configuration failed: ' + result);
      if (shape === 'scale' && slot !== 3) sprite.setScaleMultipliers(58982, 72090);
      sprite.blendMode = 0x20;
      sprite.setActivation(1);
    }
    return {
      manager,
      output,
      run: () => renderer.drawFull(),
      dispose() {
        manager.dispose();
        processing.dispose();
        for (const slot of text ? [1, 2, 3] : [1, 2]) surfaces.release(slot);
        output.storage.release();
      },
    };
  }
  const cases = [];
  for (const shape of ['translation', 'rotation', 'scale'])
    for (const text of [false, true]) {
      const fixture = create(shape, text),
        samples = budgets.map(() => []),
        outputs = [];
      try {
        // Interleave budgets and reverse each pass to limit warmup/order bias.
        for (let pass = 0; pass < options.iterations + 3; pass++) {
          const order = budgets.map((_, index) => index);
          if (pass & 1) order.reverse();
          for (const index of order) {
            fixture.manager.setRenderPixelBudget(budgets[index]);
            setRuntimeProfile(profileFor(index));
            await new Promise((resolve) => setTimeout(resolve, 0));
            const start = performance.now();
            fixture.run();
            const elapsed = performance.now() - start;
            if (pass >= 3) samples[index].push(elapsed);
            if (pass === options.iterations + 2) {
              outputs[index] = {
                native: fixture.output.storage.bytes.slice(),
                presentation: rasterTextBitmap(fixture.output).storage.bytes.slice(),
                glyphFragments: readRasterText(fixture.output).length,
              };
              if (text && outputs[index].glyphFragments === 0)
                throw new Error('Synthetic text did not reach the output');
            }
          }
        }
        if (
          difference(outputs[2].native, outputs[4].native).bytes !== 0 ||
          difference(outputs[2].presentation, outputs[4].presentation).bytes !== 0
        )
          throw new Error('Browser profile differs from the equivalent explicit job budget');
        cases.push({
          shape,
          text,
          width,
          height,
          budgets: budgets.map((budget, index) => ({
            budget,
            profile: profileFor(index),
            stripRows: Math.max(
              1,
              Math.floor(
                (profileFor(index) === 'native' ? budget : Math.max(budget, 65536)) / width,
              ),
            ),
            medianMs: +[...samples[index]]
              .sort((a, b) => a - b)
              [samples[index].length >> 1].toFixed(2),
            samplesMs: samples[index].map((value) => +value.toFixed(2)),
            hash: hash(outputs[index].native),
            presentationHash: hash(outputs[index].presentation),
            difference: difference(outputs[0].native, outputs[index].native),
            presentationDifference: difference(
              outputs[0].presentation,
              outputs[index].presentation,
            ),
            glyphFragments: outputs[index].glyphFragments,
          })),
        });
      } finally {
        fixture.dispose();
        setRuntimeProfile('native');
      }
    }
  return {
    available: true,
    synthetic: true,
    cases,
    note: 'Complete synchronous generated scene draws; no frame cadence or game assets. Larger strips may change native rounding and callback order.',
  };
}

await runSyntheticBrowserProbe({
  options,
  pageMain,
  runtimeRoot: resolve('dist'),
  name: 'vn-render-strips',
});
