import type {BurikoBitmap} from './bitmap.js';
import {burikoSignedProduct16, saturateBurikoByte} from './bitmap-pairs.js';
import {bitmapRead8, bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';

const repeatWords = 0x0000000100010001n;
const repeatShiftedWords = 0x0000001000100010n;
type Coefficient = readonly [number, number, number, number];
function unpack(value: bigint): Coefficient {
  const word = (shift: bigint): number => (Number((value >> shift) & 65535n) << 16) >> 16;
  return [word(0n), word(16n), word(32n), word(48n)];
}

/** 0040BDA0/0040C090 store period and reciprocal as binary64 before their x87 loop. */
function triangleTable(parameter: number, extra: number): Coefficient[] {
  const period = 256 / ((parameter & 7) * 2 + 1),
    frequency = 1 / period,
    denominator = period * 256;
  return Array.from({length: 256}, (_, index) => {
    const band = Math.trunc(index * frequency);
    let residual = index - band * period;
    if ((band & 1) !== 0) residual = period - residual;
    const value =
      extra === 0 ? residual * frequency * 256 : (residual * (extra >>> 0) * 256) / denominator;
    // CDQ replaces __ftol's high return word before the signed __allmul call.
    return unpack(BigInt(Math.trunc(value) | 0) * repeatShiftedWords);
  });
}

/** 0040BC40/0040BEF0 dispatch to the four MMX mask-transition kernels.
 * Three replicated coefficient words retain the destination high byte on normal inputs.
 * Parameters >=8 select one of eight triangle frequencies using only their low three bits. */
export function transitionLegacy169BitmapPixels(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  mask: BurikoBitmap,
  parameter: number,
  blend: number,
  extra: number,
): void {
  const small = parameter >>> 0 < 8;
  let coefficients: Coefficient[];
  if (!small) coefficients = triangleTable(parameter, extra);
  else if (extra === 0)
    coefficients = Array.from({length: 128}, (_, index) => unpack(BigInt(index) * repeatWords));
  else {
    let accumulator = 0;
    coefficients = Array.from({length: 129}, () => {
      const coefficient = BigInt(accumulator >>> 8) * repeatWords;
      accumulator = (accumulator + 256 - extra) >>> 0;
      return unpack(coefficient);
    });
  }
  const bias = small ? (256 - Math.imul((1 << parameter) + 1, blend)) | 0 : (128 - blend) * 2;
  for (let y = 0; y < source.height; y++)
    for (let x = 0; x < source.width; x++) {
      const byte = bitmapRead8(mask, mask.offset + y * mask.stride + x),
        coverage = ((small ? byte << parameter : byte) + bias) | 0;
      if (coverage <= 0) continue;
      const output = destination.offset + y * destination.stride + x * 4,
        input = source.offset + y * source.stride + x * 4;
      if (extra === 0 && coverage >= 256) {
        bitmapWrite32(destination, output, bitmapRead32(source, input));
        continue;
      }
      // 0040C1AD writes EAX (pixel index), not EDX (coverage). The subsequent
      // coefficient read is outside its 256 initialized entries, including 256.
      if (!small && coverage >= 256)
        throw new RangeError('Buriko 1.69 triangle transition reads unwritten coefficient storage');
      const coefficient = coefficients[small ? Math.min(256, coverage) >>> 1 : coverage]!,
        old = bitmapRead32(destination, output),
        pixel = bitmapRead32(source, input);
      let result = 0;
      for (let shift = 0; shift < 32; shift += 8) {
        const previous = (old >>> shift) & 255,
          difference = ((pixel >>> shift) & 255) - previous,
          multiplier = coefficient[shift >>> 3]!,
          delta = small
            ? burikoSignedProduct16(difference, multiplier) >> 7
            : Math.imul(difference << 4, multiplier) >> 16;
        result |= saturateBurikoByte(previous + delta) << shift;
      }
      bitmapWrite32(destination, output, result);
    }
}
