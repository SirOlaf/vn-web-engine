import {withBurikoBitmapText} from './bitmap-dom-text.js';
import {bitmapStorage, type BurikoBitmap} from './bitmap.js';
import type {BurikoBitmapCompositor} from './bitmap-compositor.js';
import {runBurikoBitmapOperation} from './bitmap-operation-jobs.js';
import type {BurikoSurfaceToneCurve} from './surface-tone-curves.js';

function interpolate(source: number, target: number, halfLevel: number): number {
  const product = Math.imul((target - source) & 65535, halfLevel) & 65535;
  return (source + (((product << 16) >> 16) >> 7)) & 65535;
}
function pack(value: number): number {
  return Math.max(0, Math.min(255, (value << 16) >> 16));
}
function tonePixel(
  pixel: number,
  monochrome: number,
  monoLevel: number,
  curve: BurikoSurfaceToneCurve,
  film: number,
  filmLevel: number,
): number {
  const luminance = (pixel & 255) * 29 + ((pixel >>> 8) & 255) * 150 + ((pixel >>> 16) & 255) * 77;
  let mapped = 0;
  for (let channel = 0; channel < 3; channel++) {
    const shift = channel * 8,
      value = interpolate(
        (pixel >>> shift) & 255,
        (luminance * ((monochrome >>> shift) & 255)) >>> 16,
        monoLevel >>> 1,
      ),
      entry = curve.values[(2 - channel) * 256 + value];
    if (entry === undefined)
      throw new Error('Buriko tone kernel reads outside its initialized table');
    mapped |= entry;
  }
  let output = 0;
  for (let shift = 0; shift < 24; shift += 8) {
    const value = (mapped >>> shift) & 255,
      color = (film >>> shift) & 255,
      mask = value > 127 ? 255 : 0,
      target = ((Math.imul(value ^ mask, color ^ mask) & 65535) >>> 7) ^ mask;
    output |= pack(interpolate(value, target, filmLevel >>> 1)) << shift;
  }
  return output >>> 0;
}

/** 0546B0 and 053340/052F40: paired SSE word arithmetic with actual strip dispatch. */
function applyBurikoBitmapTonePixels(
  compositor: BurikoBitmapCompositor,
  destination: BurikoBitmap,
  source: BurikoBitmap,
  monochrome: number,
  monoLevel: number,
  curve: BurikoSurfaceToneCurve,
  film: number,
  filmMode: number,
  filmLevel: number,
  parallel = true,
): number {
  if (destination.format !== source.format) return 0x0f;
  if ((source.format - 1) >>> 0 > 1) return 9;
  if (monoLevel >>> 0 > 256) return 0x17;
  if (filmMode !== 8 && filmMode !== 0x26) return 2;
  if (filmLevel >>> 0 > 256) return 3;
  if (
    parallel &&
    runBurikoBitmapOperation(compositor.processing, [destination, source], source, 0, (bitmaps) => {
      applyBurikoBitmapTone(
        compositor,
        bitmaps[0]!,
        bitmaps[1]!,
        monochrome,
        monoLevel,
        curve,
        film,
        filmMode,
        filmLevel,
        false,
      );
    })
  )
    return 0;
  const width = Math.min(destination.width >>> 0, source.width >>> 0),
    height = Math.min(destination.height >>> 0, source.height >>> 0),
    alpha = source.format === 2;
  const transform = (pixel: number) =>
    (tonePixel(pixel, monochrome, monoLevel, curve, film, filmLevel) |
      (alpha ? pixel & 0xff000000 : 0)) >>>
    0;
  for (let y = 0; y < height; y++) {
    const srcRow = source.offset + y * (source.stride | 0),
      dstRow = destination.offset + y * (destination.stride | 0);
    let x = 0;
    for (; x + 1 < width; x += 2) {
      const src = srcRow + x * 4,
        dst = dstRow + x * 4,
        pair = bitmapStorage(source, src, 8, true).view.getBigUint64(src, true),
        first = Number(pair & 0xffffffffn),
        second = Number(pair >> 32n);
      let result = 0n;
      if (!alpha || ((first | second) & 0xff000000) !== 0) {
        const low = transform(first),
          high = transform(second);
        result = BigInt(low) | (BigInt(high) << 32n);
      }
      const backing = bitmapStorage(destination, dst, 8, false);
      backing.view.setBigUint64(dst, result, true);
      backing.written(dst, 8);
    }
    if (x < width) {
      const src = srcRow + x * 4,
        dst = dstRow + x * 4,
        pixel = bitmapStorage(source, src, 4, true).view.getUint32(src, true),
        result = alpha && (pixel & 0xff000000) === 0 ? 0 : transform(pixel),
        backing = bitmapStorage(destination, dst, 4, false);
      backing.view.setUint32(dst, result, true);
      backing.written(dst, 4);
    }
  }
  return 0;
}

export const applyBurikoBitmapTone = withBurikoBitmapText(applyBurikoBitmapTonePixels, {
  alternateArgs: (args) => {
    const alternate = [...args] as Parameters<typeof applyBurikoBitmapTonePixels>;
    alternate[9] = false;
    return alternate;
  },
  destination: 1,
  source: 2,
  replace: true,
  applied: (result) => result === 0,
});
