import {withBurikoBitmapText} from './bitmap-dom-text.js';
import {
  burikoBitmapRectangle,
  cropBurikoBitmap,
  intersectBurikoBitmapRectangle,
  translateBurikoBitmapRectangle,
  type BurikoBitmap,
} from './bitmap.js';
import {burikoSignedProduct16, saturateBurikoByte} from './bitmap-pairs.js';
import {bitmapRead8, bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';

function cvtt32(value: number): number {
  const integer = Math.trunc(value);
  return !Number.isFinite(integer) || integer < -0x80000000 || integer > 0x7fffffff
    ? -0x80000000
    : integer | 0;
}

/** 04BA70/04B660 use separate, ordered double operations and signed CVTT32. */
function triangleTable(parameter: number, extra: number): number[] {
  const q = (Math.imul(parameter, 2) + 1) >>> 0,
    period = 256 / q,
    frequency = q / 256;
  const table: number[] = [];
  for (let index = 0; index < (extra === 0 ? 256 : 257); index++) {
    const band = cvtt32(index * frequency);
    let residual = index - band * period;
    if ((band & 1) !== 0) residual = period - residual;
    const scaled = residual * 256;
    table.push(
      extra === 0
        ? (cvtt32(scaled * frequency) << 4) & 65535
        : (cvtt32(scaled * (extra >>> 0) * frequency) >> 4) & 65535,
    );
  }
  return table;
}

/** Exact04BC40/04B860/04BA70/04B660 scalar MOVD traversal on shared storage. */
function transition32(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  mask: BurikoBitmap,
  parameter: number,
  blend: number,
  extra: number,
): void {
  const small = parameter >>> 0 < 8;
  let coefficients: number[] = [];
  if (!small) coefficients = triangleTable(parameter, extra);
  else if (extra !== 0) {
    let accumulator = 0;
    for (let index = 0; index <= 128; index++) {
      coefficients.push((accumulator >>> 3) & 65535);
      accumulator = (accumulator + 256 - extra) >>> 0;
    }
  }
  const bounds = small && extra === 0 ? destination : source;
  const bias = small ? (Math.imul(~(1 << parameter), blend) + 256) | 0 : Math.imul(128 - blend, 2);
  for (let y = 0; y < bounds.height >>> 0; y++) {
    for (let x = 0; x < bounds.width >>> 0; x++) {
      const byte = bitmapRead8(mask, mask.offset + y * mask.stride + x);
      const coverage = ((small ? byte << parameter : byte) + bias) | 0;
      if (coverage <= 0) continue;
      const output = destination.offset + y * destination.stride + x * 4;
      const input = source.offset + y * source.stride + x * 4;
      if (extra === 0 && coverage >= 256) {
        bitmapWrite32(destination, output, bitmapRead32(source, input));
        continue;
      }
      const old = bitmapRead32(destination, output),
        pixel = bitmapRead32(source, input);
      const coefficient =
        small && extra === 0
          ? coverage >> 1
          : (coefficients[small ? Math.min(128, coverage >> 1) : Math.min(256, coverage)]! << 16) >>
            16;
      let result = old & 0xff000000;
      for (let shift = 0; shift < 24; shift += 8) {
        const previous = (old >>> shift) & 255,
          difference = ((pixel >>> shift) & 255) - previous;
        const delta =
          small && extra === 0
            ? burikoSignedProduct16(difference, coefficient) >> 7
            : Math.floor(((difference << 4) * coefficient) / 65536);
        result |= saturateBurikoByte(previous + delta) << shift;
      }
      bitmapWrite32(destination, output, result);
    }
  }
}

/** 04E3A0 clips three descriptors before actual04BA00/04BD70 format dispatch. */
function transitionBurikoBitmapPixels(
  destination: BurikoBitmap,
  x: number,
  y: number,
  source: BurikoBitmap,
  mask: BurikoBitmap,
  parameter: number,
  blend: number,
  extra: number,
  maskAtDestination: boolean,
): 0 | 1 | 3 | 4 | 7 | 8 {
  const output = {...destination},
    input = {...source},
    matte = {...mask};
  if (matte.format !== 3) return 7;
  if (!maskAtDestination && (input.width !== matte.width || input.height !== matte.height))
    return 8;
  if (blend >>> 0 > 256) return 3;
  const area = burikoBitmapRectangle(input),
    outputArea = burikoBitmapRectangle(output);
  translateBurikoBitmapRectangle(outputArea, -x, -y);
  if (!intersectBurikoBitmapRectangle(area, outputArea)) return 4;
  if (!maskAtDestination) {
    cropBurikoBitmap(input, area);
    cropBurikoBitmap(matte, area);
    translateBurikoBitmapRectangle(area, x, y);
  } else {
    const maskArea = burikoBitmapRectangle(matte);
    translateBurikoBitmapRectangle(maskArea, -x, -y);
    if (!intersectBurikoBitmapRectangle(area, maskArea)) return 4;
    cropBurikoBitmap(input, area);
    translateBurikoBitmapRectangle(area, x, y);
    intersectBurikoBitmapRectangle(area, burikoBitmapRectangle(matte));
    cropBurikoBitmap(matte, area);
  }
  cropBurikoBitmap(output, area);
  if (output.format !== input.format) return 1;
  if (input.format === 1)
    transition32(output, input, matte, parameter >>> 0, blend >>> 0, extra >>> 0);
  return 0;
}

export const transitionBurikoBitmap = withBurikoBitmapText(transitionBurikoBitmapPixels, {
  source: 3,
  applied: (result, args) => result === 0 && args[3].format === 1,
  map: (x, y, args) => [x + args[1], y + args[2]],
});
