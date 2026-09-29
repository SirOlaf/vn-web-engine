import {fileURLToPath} from 'node:url';
import {
  parseSyntheticBrowserOptions,
  runSyntheticBrowserProbe,
} from './lib/synthetic-browser-probe.mjs';

/**
 * Runs each GPU-composited kernel on generated pixels twice: in software on one display texture
 * and through a GPU frame on an identical one, whose display image is then read back. Reports
 * every case whose logical display bytes differ. A kernel without GPU support must fail its
 * frame and leave the display exactly as before.
 */
async function pageMain(_fixture, options) {
  const load = (path) => import('/runtime/engines/buriko/native/' + path);
  const [
    bitmap,
    compositorModule,
    alpha,
    copy,
    effects,
    affine,
    texture,
    presenter,
    gpu,
    mix,
    gpuTarget,
    transition,
  ] = await Promise.all([
    load('bitmap.js'),
    load('bitmap-compositor.js'),
    load('bitmap-alpha.js'),
    load('bitmap-copy.js'),
    load('bitmap-effects.js'),
    load('bitmap-affine.js'),
    load('display-texture.js'),
    load('display-gpu-presenter.js'),
    load('display-gpu-compositor.js'),
    load('bitmap-mix.js'),
    load('bitmap-gpu-target.js'),
    load('bitmap-transition.js'),
  ]);
  const target = presenter.BurikoGpuPresenter.create(document);
  if (target === null) return {available: false, reason: 'WebGL 2 unavailable'};
  const composer = new gpu.BurikoGpuCompositor(target);
  const compositor = new compositorModule.BurikoBitmapCompositor();
  let seed = 0x6c8e9cf5;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const logicalWidth = options.smoke ? 160 : 640,
    logicalHeight = options.smoke ? 90 : 360;
  const [textureWidth, textureHeight] = texture.burikoDisplayTextureSize(
    logicalWidth,
    logicalHeight,
  );
  const alphas = [0, 0, 1, 2, 3, 127, 128, 200, 253, 254, 255, 255];
  function source(width, height, format) {
    const stride = (width + (random() % 3)) * 4;
    const storage = bitmap.BurikoBitmapStorage.allocate(stride * height + 16, true);
    const words = new Uint32Array(
      storage.bytes.buffer,
      storage.bytes.byteOffset,
      storage.bytes.byteLength >>> 2,
    );
    for (let i = 0; i < words.length; i++) {
      const value = random();
      words[i] =
        format === 2 && random() % 4 !== 0
          ? ((value & 0xffffff) | (alphas[random() % alphas.length] << 24)) >>> 0
          : value;
    }
    return {storage, offset: 0, stride, width, height, format, bytesPerPixel: 4};
  }
  function display() {
    const result = new texture.BurikoDisplayTexture(textureWidth, textureHeight, 22);
    const words = new Uint32Array(
      result.storage.bytes.buffer,
      result.storage.bytes.byteOffset,
      result.storage.bytes.byteLength >>> 2,
    );
    for (let i = 0; i < words.length; i++) words[i] = random();
    return result;
  }
  function descriptor(storage, rectangle) {
    const value = {
      storage,
      offset: 0,
      stride: textureWidth * 4,
      width: logicalWidth,
      height: logicalHeight,
      format: 1,
      bytesPerPixel: 4,
    };
    bitmap.cropBurikoBitmap(value, rectangle);
    return value;
  }
  const rectangle = () => {
    const left = random() % (logicalWidth - 8),
      top = random() % (logicalHeight - 8);
    const right = Math.min(logicalWidth - 1, left + 1 + (random() % 300)),
      bottom = Math.min(logicalHeight - 1, top + 1 + (random() % 200));
    return {left, top, right, bottom};
  };
  const transparencies = [0, 1, 64, 128, 200, 255];
  const cases = [];
  for (let index = 0; index < (options.smoke ? 4 : 24); index++) {
    const t = transparencies[index % transparencies.length];
    cases.push(
      ['copy rows', (d, s) => copy.copyBurikoBitmapRows(d, s), 1],
      ['clear', (d) => copy.clearBurikoBitmap(d), 1],
      ['dim rgb ' + t, (d, s) => effects.dimBurikoRgb(d, s, t), 1],
      ['mix all ' + t, (d, s) => alpha.mixBurikoAllChannels(d, s, t), 1],
      ['alpha into rgb', (d, s) => alpha.blendBurikoAlphaIntoRgb(d, s), 2],
      [
        'alpha transparency ' + t,
        (d, s) => alpha.blendBurikoAlphaIntoRgbWithTransparency(d, s, t),
        2,
      ],
      ['composite 1/' + t, (d, s) => compositor.composite(d, s, 1, t, true), 2],
      ['composite 0x80', (d, s) => compositor.composite(d, s, 0x80, 0, true), 1],
      ['composite 0xc0 ' + t, (d, s) => compositor.composite(d, s, 0xc0, t, true), 1],
    );
    const angle = [0, 0, 5, -30, 90, 180][index % 6] * 65536,
      scale = [65536, 65536, 50000, 98304, 65536, 70000][index % 6],
      sampling = index & 1;
    const transform = {
      x: (random() % (200 * 65536)) - 100 * 65536,
      y: (random() % (200 * 65536)) - 100 * 65536,
      pivotX: (random() % 64) * 65536 + (index % 3 === 0 ? 0 : random() % 65536),
      pivotY: (random() % 64) * 65536,
      angle,
      scaleX: scale,
      scaleY: index % 4 === 0 ? scale : 65536,
    };
    cases.push([
      `affine a${angle >> 16} s${scale} b${sampling} t${t}`,
      (d, s) => affine.blendTransformedBurikoBitmap(compositor, d, s, transform, t, sampling, true),
      2,
      true,
    ]);
    const aligned = {
      x: 0,
      y: 0,
      pivotX: (random() % 8) * 65536,
      pivotY: (random() % 8) * 65536,
      angle: 0,
      scaleX: 65536,
      scaleY: 65536,
    };
    cases.push([
      `affine aligned t${t}`,
      (d, s) => affine.blendTransformedBurikoBitmap(compositor, d, s, aligned, t, 0, true),
      2,
      true,
    ]);
  }
  // A source written between two draws of one frame must be uploaded again.
  const flip = (bitmap) => {
    const bytes = bitmap.storage.bytes;
    for (let row = 0; row < bitmap.height; row++)
      for (let byte = 0; byte < bitmap.width * 4; byte++)
        bytes[bitmap.offset + row * bitmap.stride + byte] ^= 0x5a;
  };
  for (let index = 0; index < 4; index++)
    cases.push([
      'source rewritten within a frame',
      (d, s) => {
        alpha.blendBurikoAlphaIntoRgb(d, s);
        flip(s);
        compositor.composite(d, s, 1, 64, true);
        flip(s);
        alpha.blendBurikoAlphaIntoRgb(d, s);
      },
      2,
    ]);
  // Masked transitions: small and triangle parameters, with and without `extra`, both mask
  // placements, and offsets that clip against the destination.
  const masks = new WeakMap(),
    seconds2 = new WeakMap();
  const maskFor = (s) => {
    if (!masks.has(s)) {
      const stride = s.width + (random() % 5);
      const storage = bitmap.BurikoBitmapStorage.allocate(stride * s.height + 8, true);
      const bytes = storage.bytes;
      for (let i = 0; i < bytes.length; i++) bytes[i] = random() & 255;
      masks.set(s, {
        storage,
        offset: 0,
        stride,
        width: s.width,
        height: s.height,
        format: 3,
        bytesPerPixel: 1,
      });
    }
    return masks.get(s);
  };
  for (const [parameter, blend, extra] of [
    [0, 0, 0],
    [0, 128, 0],
    [3, 200, 0],
    [7, 256, 0],
    [2, 90, 40],
    [9, 60, 0],
    [12, 128, 3],
    [30, 250, 200],
  ])
    for (const [atDestination, dx, dy] of [
      [false, 0, 0],
      [false, -7, 5],
      [true, 3, -2],
    ])
      cases.push([
        `transition p${parameter} b${blend} e${extra} ${atDestination ? 'at destination' : 'at source'} ${dx},${dy}`,
        (d, s) =>
          transition.transitionBurikoBitmap(
            d,
            dx,
            dy,
            s,
            maskFor(s),
            parameter,
            blend,
            extra,
            atDestination,
            '1.72',
          ),
        1,
      ]);
  for (const [factor, transparency] of [
    [0, 0],
    [1, 0],
    [128, 0],
    [128, 90],
    [200, 255],
    [256, 0],
    [256, 30],
  ])
    cases.push([
      `mixed into rgb f${factor} t${transparency}`,
      (d, s) => {
        if (!seconds2.has(s)) seconds2.set(s, source(s.width, s.height, 2));
        mix.blendMixedBurikoBitmapsIntoRgb(d, s, seconds2.get(s), factor, transparency);
      },
      2,
    ]);
  // Sprite mixes are recorded, drawn by the GPU when a frame reads them, and settled in
  // software on any later software access.
  const seconds = new WeakMap();
  for (const factor of [0, 1, 64, 128, 200, 255, 256])
    for (const format of [1, 2])
      cases.push([
        `deferred mix f${factor} rgb${format === 1 ? '' : 'a'}`,
        (d, s, mixes) => {
          if (!seconds.has(s)) seconds.set(s, source(s.width, s.height, format));
          const out = bitmap.allocateBurikoBitmap(s.width, s.height, format);
          mix.mixBurikoBitmaps(out, s, seconds.get(s), factor, null, 1);
          compositor.composite(d, out, format === 1 ? 0x80 : 1, 0, true);
          mixes.push(out);
        },
        format,
      ]);
  cases.push([
    'unsupported screen',
    (d, s) => effects.screenBurikoBitmap(d, s, 128, false),
    1,
    false,
    true,
  ]);
  const results = [];
  let failed = 0;
  for (const [name, run, format, sourceCoversDestination, expectFallback] of cases) {
    const area = rectangle();
    const width = area.right - area.left + 1,
      height = area.bottom - area.top + 1;
    const input = sourceCoversDestination
      ? source(80 + (random() % 400), 60 + (random() % 300), format)
      : source(width, height, format);
    const software = display(),
      hardware = new texture.BurikoDisplayTexture(textureWidth, textureHeight, 22);
    hardware.storage.bytes.set(software.storage.bytes);
    // Software reference.
    const softwareMixes = [],
      hardwareMixes = [];
    run(descriptor(software.storage, area), input, softwareMixes);
    // GPU frame over the same area; a fresh display image is uploaded from the initial bytes.
    target.invalidate();
    const context = {
      bitmap: {
        storage: hardware.storage,
        offset: 0,
        stride: textureWidth * 4,
        width: logicalWidth,
        height: logicalHeight,
        format: 1,
        bytesPerPixel: 4,
      },
      bounds: {left: 0, top: 0, right: logicalWidth - 1, bottom: logicalHeight - 1},
    };
    if (!composer.begin(context, hardware, logicalWidth, logicalHeight, area)) {
      results.push({name, error: 'begin refused'});
      failed++;
      continue;
    }
    const destination = {...context.bitmap};
    bitmap.cropBurikoBitmap(destination, area);
    gpuTarget.setBurikoGpuDeferrer(composer);
    run(destination, input, hardwareMixes);
    gpuTarget.setBurikoGpuDeferrer(null);
    const drawn = composer.end(context);
    // A mix the GPU drew stays pending: nothing has read it in software yet.
    const unsettled = hardwareMixes.every((out) => out.storage.pending !== null);
    composer.syncSoftware(hardware);
    if (!drawn) run(descriptor(hardware.storage, area), input, []);
    // Software access settles each deferred mix exactly.
    let mixDiffering = 0;
    softwareMixes.forEach((expected, index) => {
      const actual = hardwareMixes[index].storage.bytes,
        reference = expected.storage.bytes;
      for (let i = 0; i < reference.length; i++) if (actual[i] !== reference[i]) mixDiffering++;
    });
    let differing = 0,
      first = null;
    const a = software.storage.view,
      b = hardware.storage.view;
    for (let y = 0; y < logicalHeight; y++)
      for (let x = 0; x < logicalWidth; x++) {
        const offset = y * textureWidth * 4 + x * 4;
        if (a.getUint32(offset, true) !== b.getUint32(offset, true)) {
          differing++;
          first ??= {
            x,
            y,
            expected: a.getUint32(offset, true).toString(16),
            actual: b.getUint32(offset, true).toString(16),
          };
        }
      }
    const fallbackMismatch = drawn === Boolean(expectFallback);
    const bad = differing !== 0 || fallbackMismatch || mixDiffering !== 0 || !unsettled;
    if (bad) failed++;
    if (bad || options.verbose)
      results.push({
        name,
        area,
        source: [input.width, input.height],
        drawn,
        differing,
        mixDiffering,
        unsettled,
        first,
      });
    software.dispose();
    hardware.dispose();
    input.storage.release();
    // Reset the fallback cooldown so every case exercises the GPU path.
    composer.cooldown = 0;
  }
  return {available: true, cases: cases.length, failed, results};
}

if (process.argv.includes('--help')) {
  console.log(
    'Usage: node tools/probe-buriko-gpu-compositor.mjs [--browser path] [--output results.json] [--smoke]',
  );
  console.log(
    'Compares GPU-composited Buriko kernels with the software kernels over generated pixels. Build dist first with npm run build:runtime.',
  );
} else {
  try {
    await runSyntheticBrowserProbe({
      options: parseSyntheticBrowserOptions(process.argv.slice(2)),
      pageMain,
      runtimeRoot: fileURLToPath(new URL('../dist/', import.meta.url)),
      name: 'vn-gpu-compositor',
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
