import type {BurikoBpAbi} from '../bp/abi.js';
import {allocateBurikoBitmap, type BurikoBitmap, BurikoBitmapStorage} from './bitmap.js';
import {bitmapRead32, bitmapWrite16, bitmapWrite32} from './bitmap-scalar.js';
import {
  nativeDisplacementSineRadians as sine,
  nativeDisplacementCosineRadians as cosine,
} from '../bp/opcodes/native-math.js';

function cvtt32(value: number): number {
  const integer = Math.trunc(value);
  return !Number.isFinite(integer) || integer < -2147483648 || integer > 2147483647
    ? -2147483648
    : integer;
}
function cvtt64(value: number): bigint {
  return !Number.isFinite(value) || value < -(2 ** 63) || value >= 2 ** 63
    ? -(1n << 63n)
    : BigInt(Math.trunc(value));
}
function valid(bitmap: BurikoBitmap): boolean {
  return bitmap.format === 4 && bitmap.width >>> 0 !== 0 && bitmap.height >>> 0 !== 0;
}

/** 034490: unsigned heights, wrapped signed IMUL64/IDIV, and upper-only clamp. */
export function deriveBurikoHeightDisplacement(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  scale: number,
): number {
  if (!valid(destination)) return 0x80000003;
  if (
    source.format !== 5 ||
    source.width >>> 0 !== (destination.width + 1) >>> 0 ||
    source.height >>> 0 !== (destination.height + 1) >>> 0
  )
    return 0x80000004;
  scale >>>= 0;
  const divisor = BigInt(((scale === 0 ? 1 : scale) * 2) >>> 0);
  const component = (first: number, second: number): number => {
    if (first === second) return 0;
    const minimum = BigInt(Math.min(first, second)),
      maximum = BigInt(Math.max(first, second));
    if (divisor === 0n)
      throw new Error('Buriko height displacement reaches native zero IDIV divisor');
    const quotient = BigInt.asIntN(64, (maximum + minimum) * (maximum - minimum)) / divisor;
    const word = quotient < 32768n ? Number(BigInt.asUintN(16, quotient)) : 32767;
    return first > second ? -word : word;
  };
  for (let y = 0; y < destination.height >>> 0; y++) {
    const from = source.offset + y * (source.stride | 0),
      to = destination.offset + y * (destination.stride | 0);
    for (let x = 0; x < destination.width >>> 0; x++) {
      const at = from + x * 4;
      bitmapWrite16(
        destination,
        to + x * 4,
        component(bitmapRead32(source, at), bitmapRead32(source, at + 4)),
      );
      bitmapWrite16(
        destination,
        to + x * 4 + 2,
        component(bitmapRead32(source, at), bitmapRead32(source, at + (source.stride | 0))),
      );
    }
  }
  return 0;
}

/** 034260: cosine ripple heights followed by the shared native gradient. */
export function fillBurikoRippleDisplacement(
  bitmap: BurikoBitmap,
  centerX: number,
  centerY: number,
  period: number,
  phase: number,
  amplitude: number,
  revision?: BurikoBpAbi['revision'],
): number {
  if (!valid(bitmap)) return 0x80000003;
  period >>>= 0;
  phase >>>= 0;
  amplitude >>>= 0;
  if (period === 0) return 0x80000006;
  const scratch = allocateBurikoBitmap((bitmap.width + 1) | 0, (bitmap.height + 1) | 0, 5);
  let dy = centerY | 0;
  for (let y = 0; y < scratch.height >>> 0; y++, dy = (dy - 1) | 0) {
    let dx = centerX | 0;
    for (let x = 0; x < scratch.width >>> 0; x++, dx = (dx - 1) | 0) {
      const radius = Math.sqrt(dx * dx + dy * dy);
      const height = cvtt64(
        (1 - cosine(((radius - phase) * 6.283185307179586) / period, revision)) * amplitude,
      );
      bitmapWrite32(
        scratch,
        scratch.offset + y * (scratch.stride | 0) + x * 4,
        Number(BigInt.asUintN(32, height)),
      );
    }
  }
  const result = deriveBurikoHeightDisplacement(bitmap, scratch, 65536);
  scratch.storage?.release();
  return result;
}

/** 033890: finite-radius sine heights, preserving the wrapped doubled radius. */
export function fillBurikoCurvedDisplacement(
  bitmap: BurikoBitmap,
  centerX: number,
  centerY: number,
  strength: number,
  radius: number,
  revision?: BurikoBpAbi['revision'],
): number {
  if (!valid(bitmap)) return 0x80000003;
  strength >>>= 0;
  radius >>>= 0;
  if (strength === 0 || radius === 0) return 0x80000008;
  const scratch = allocateBurikoBitmap((bitmap.width + 1) | 0, (bitmap.height + 1) | 0, 5);
  for (let y = 0; y < scratch.height >>> 0; y++) {
    const dy = (y - centerY) | 0;
    for (let x = 0; x < scratch.width >>> 0; x++) {
      const dx = (x - centerX) | 0,
        distance = Math.sqrt(dx * dx + dy * dy);
      const height =
        distance >= radius
          ? 0n
          : cvtt64(
              4194304 -
                sine((distance * 3.141592653589793) / ((radius * 2) >>> 0), revision) * 4194304,
            );
      bitmapWrite32(
        scratch,
        scratch.offset + y * (scratch.stride | 0) + x * 4,
        Number(BigInt.asUintN(32, height)),
      );
    }
  }
  const result = deriveBurikoHeightDisplacement(bitmap, scratch, Math.floor(0x40000000 / strength));
  scratch.storage?.release();
  return result;
}

/** 033580: row-X and column-Y WORD tables, with separate signed-positive loops. */
export function fillBurikoSineDisplacement(
  bitmap: BurikoBitmap,
  periodX: number,
  phaseX: number,
  amplitudeX: number,
  periodY: number,
  phaseY: number,
  amplitudeY: number,
  revision?: BurikoBpAbi['revision'],
): number {
  if (!valid(bitmap)) return 0x80000003;
  periodX >>>= 0;
  periodY >>>= 0;
  phaseX |= 0;
  phaseY |= 0;
  amplitudeX |= 0;
  amplitudeY |= 0;
  if (periodX === 0) {
    periodX = 1;
    amplitudeX = 0;
  }
  if (periodY === 0) {
    periodY = 1;
    amplitudeY = 0;
  }
  const rows = new BurikoBitmapStorage(new Uint8Array((bitmap.height >>> 0) * 2), false);
  const columns = new BurikoBitmapStorage(new Uint8Array((bitmap.width >>> 0) * 2), false);
  for (let y = 0; y < (bitmap.height | 0); y++) {
    rows.view.setUint16(
      y * 2,
      cvtt32(sine(((y + phaseY) * 6.283185307179586) / periodY, revision) * amplitudeY * 16),
      true,
    );
    rows.written(y * 2, 2);
  }
  for (let x = 0; x < (bitmap.width | 0); x++) {
    columns.view.setUint16(
      x * 2,
      cvtt32(sine(((x + phaseX) * 6.283185307179586) / periodX, revision) * amplitudeX * 16),
      true,
    );
    columns.written(x * 2, 2);
  }
  for (let y = 0; y < (bitmap.height | 0); y++)
    for (let x = 0; x < (bitmap.width | 0); x++) {
      const at = bitmap.offset + y * (bitmap.stride | 0) + x * 4;
      rows.range(y * 2, 2, true);
      bitmapWrite16(bitmap, at, rows.view.getUint16(y * 2, true));
      columns.range(x * 2, 2, true);
      bitmapWrite16(bitmap, at + 2, columns.view.getUint16(x * 2, true));
    }
  rows.release();
  columns.release();
  return 0;
}

/** 0332A0: the pure 0315F0 angle result is discarded; only X uses the sine. */
export function fillBurikoPointDisplacement(
  bitmap: BurikoBitmap,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  extraRadius: number,
  revision?: BurikoBpAbi['revision'],
): number {
  if (!valid(bitmap)) return 0x80000003;
  startX |= 0;
  startY |= 0;
  endX |= 0;
  endY |= 0;
  const dx = (endX - startX) | 0,
    dy = (endY - startY) | 0;
  const denominator = Math.sqrt(dx * dx + dy * dy) + (extraRadius >>> 0);
  for (let y = 0; y < (bitmap.height | 0); y++)
    for (let x = 0; x < (bitmap.width | 0); x++) {
      const distanceX = (endX - x) | 0,
        distanceY = (endY - y) | 0;
      const factor = sine(
        (Math.sqrt(distanceX * distanceX + distanceY * distanceY) * 1.5707963267948966) /
          denominator,
        revision,
      );
      const at = bitmap.offset + y * (bitmap.stride | 0) + x * 4;
      bitmapWrite16(bitmap, at, cvtt32(factor * ((x - endX) | 0) + startX - x) << 4);
      bitmapWrite16(bitmap, at + 2, cvtt32(((y - endY) | 0) + startY - y) << 4);
    }
  return 0;
}
