import {resolve} from 'node:path';
import {
  parseSyntheticBrowserOptions,
  runSyntheticBrowserProbe,
} from './lib/synthetic-browser-probe.mjs';

// Generated numeric planes only; no game files, DOM graphics, or presentation sink.
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
  const {tryBurikoBitmapAffineAlphaWasm} =
    await import('/runtime/engines/buriko/native/bitmap-alpha-wasm.js');
  const height = options.smoke ? 48 : 1080;
  const create = (width, height, format, seed) => {
    const stride = width * 4 + 12,
      offset = 7,
      storage = new BurikoBitmapStorage(new Uint8Array(offset + stride * height), true);
    let state = seed;
    for (let index = 0; index < storage.bytes.length; index++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      storage.bytes[index] = state & 255;
    }
    return {storage, offset, stride, width, height, format, bytesPerPixel: 4};
  };
  const hash = (bytes) => {
    let value = 2166136261;
    for (const byte of bytes) value = Math.imul(value ^ byte, 16777619);
    return (value >>> 0).toString(16).padStart(8, '0');
  };
  const cases = [];
  for (const bilinear of [false, true]) {
    for (const shape of [
      'wide',
      'narrow',
      'row-shear',
      'general',
      'near-unit-minus',
      'near-unit-plus',
      'scaled',
      'reverse',
      'border',
    ]) {
      const width = options.smoke ? 385 : shape === 'narrow' ? 1005 : 1920,
        source = create(width + 256, height + 256, 2, 456),
        destination = create(width, height, 1, 123),
        initial = destination.storage.bytes.slice(),
        coordinates = {
          startX:
            shape === 'border' ? -0x9000 : (shape === 'reverse' ? width + 32 : 32) * 65536 + 0x9000,
          startY: shape === 'border' ? -0x3000 : 32 * 65536 + 0x3000,
          columnX:
            shape === 'general'
              ? 60000
              : shape === 'near-unit-minus'
                ? 65535
                : shape === 'near-unit-plus'
                  ? 65537
                  : shape === 'scaled'
                    ? 55705
                    : shape === 'reverse'
                      ? -65536
                      : 65536,
          columnY: shape === 'general' ? 512 : 0,
          rowX: shape === 'row-shear' ? 4096 : shape === 'general' ? -1024 : 0,
          rowY: shape === 'scaled' ? 72089 : 65536,
        },
        transparency = shape === 'row-shear' ? 78 : 0;
      const samples = [];
      let coldMs, checksum;
      for (let pass = 0; pass < options.iterations + 3; pass++) {
        destination.storage.bytes.set(initial);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const start = performance.now();
        for (let row = 0; row < height; row += 3) {
          const strip = {
            ...destination,
            offset: destination.offset + row * destination.stride,
            height: Math.min(3, height - row),
          };
          if (
            !tryBurikoBitmapAffineAlphaWasm(
              strip,
              source,
              destination.storage.view,
              source.storage.view,
              {
                ...coordinates,
                startX: (coordinates.startX + Math.imul(row, coordinates.rowX)) | 0,
                startY: (coordinates.startY + Math.imul(row, coordinates.rowY)) | 0,
              },
              bilinear,
              transparency,
            )
          )
            throw new Error('Synthetic affine workload left the bounded WASM path');
        }
        const elapsed = performance.now() - start;
        if (pass === 0) {
          coldMs = elapsed;
          checksum = hash(destination.storage.bytes);
        }
        if (pass >= 3) samples.push(elapsed);
      }
      const round = (value) => Math.round(value * 100) / 100;
      samples.sort((a, b) => a - b);
      cases.push({
        sampling: bilinear ? 'bilinear' : 'nearest',
        shape,
        width,
        height,
        stripRows: 3,
        transparency,
        coordinates,
        hash: checksum,
        coldMs: round(coldMs),
        medianMs: round(samples[samples.length >> 1]),
        maxMs: round(samples.at(-1)),
        samplesMs: samples.map(round),
      });
    }
  }
  return {available: true, synthetic: true, cases};
}

const result = await runSyntheticBrowserProbe({
  options,
  pageMain,
  runtimeRoot,
  name: 'vn-buriko-affine',
});
console.log(JSON.stringify({synthetic: true, cases: result.cases}, null, 2));
