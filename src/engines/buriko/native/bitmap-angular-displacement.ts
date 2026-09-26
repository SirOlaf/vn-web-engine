import type {BurikoBitmap} from './bitmap.js';
import {bitmapWrite16, bitmapWrite32} from './bitmap-scalar.js';
import {nativeDisplacementIntegerAtan2 as atan2} from './displacement-atan2.js';
import {
  nativeDisplacementSineRadians as sine,
  nativeDisplacementCosineRadians as cosine,
} from '../bp/opcodes/native-math.js';
function cvtt32(value: number): number {
  const n = Math.trunc(value);
  return !Number.isFinite(n) || n < -2147483648 || n > 2147483647 ? -2147483648 : n;
}
function valid(bitmap: BurikoBitmap): boolean {
  return bitmap.format === 4 && bitmap.width >>> 0 !== 0 && bitmap.height >>> 0 !== 0;
}
const clampWord = (value: number): number => Math.max(-32768, Math.min(32767, value));

/**033EC0: unsigned-angle projection; vertical CVTT precedes atan2(dx,dy). */
export function fillBurikoAngularProjection(
  bitmap: BurikoBitmap,
  centerX: number,
  centerY: number,
  angle: number,
  distance: number,
): number {
  if (!valid(bitmap)) return 0x80000003;
  centerX |= 0;
  centerY |= 0;
  distance >>>= 0;
  const radians = ((angle >>> 0) * 3.141592653589793) / 11796480;
  const sin = sine(radians),
    cos = cosine(radians);
  const projectionHeight = cos > 0 ? (bitmap.height >>> 0) / cos : 2147483647;
  for (let y = 0; y < bitmap.height >>> 0; y++)
    for (let x = 0; x < bitmap.width >>> 0; x++) {
      const at = bitmap.offset + y * (bitmap.stride | 0) + x * 4;
      if (!(cos > 0)) {
        bitmapWrite32(bitmap, at, 0);
        continue;
      }
      const dx = (x - centerX) | 0,
        dy = (y - centerY) | 0,
        radius = Math.sqrt(dx * dx + dy * dy);
      const vertical = cvtt32(
        ((distance + projectionHeight) * radius * 16) / (radius * sin + distance),
      );
      const theta = atan2(dx, dy);
      const horizontal = cvtt32(
        ((180 - (theta * 180) / 3.141592653589793) / 360 - 1) * (((bitmap.width - 1) << 4) >>> 0),
      );
      bitmapWrite16(bitmap, at, clampWord((-(x << 4) - horizontal) | 0));
      bitmapWrite16(bitmap, at + 2, clampWord((vertical - (y << 4)) | 0));
    }
  return 0;
}
function absolute32(value: number): number {
  const sign = value >> 31;
  return ((value ^ sign) - sign) | 0;
}

/**033B60: Y calculated first, X published first; signedWORD truncation without clamp. */
export function fillBurikoAngularBend(
  bitmap: BurikoBitmap,
  centerX: number,
  centerY: number,
  angle: number,
  radius: number,
): number {
  if (!valid(bitmap)) return 0x80000003;
  angle >>>= 0;
  radius >>>= 0;
  if (angle === 0 || radius === 0) return 0x80000008;
  const radians = (angle * 3.141592653589793) / 11796480,
    sin = sine(radians),
    cos = cosine(radians);
  let dy = -centerY | 0,
    centerYQ4 = centerY << 4;
  for (
    let y = 0;
    y < bitmap.height >>> 0;
    y++, dy = (dy + 1) | 0, centerYQ4 = (centerYQ4 - 16) | 0
  ) {
    let dx = -centerX | 0,
      centerXQ4 = centerX << 4;
    for (
      let x = 0;
      x < bitmap.width >>> 0;
      x++, dx = (dx + 1) | 0, centerXQ4 = (centerXQ4 - 16) | 0
    ) {
      const distance = Math.sqrt(dx * dx + dy * dy);
      let outputX = 0,
        outputY = 0;
      if (distance > 0 && distance < radius) {
        const t = (distance * sin) / radius,
          z = Math.sqrt(1 - t * t),
          factor = ((z - cos) * t) / z;
        const theta = atan2(absolute32(dy), absolute32(dx));
        outputY = cvtt32(sine(theta) * centerYQ4 * factor);
        outputX = cvtt32(cosine(theta) * centerXQ4 * factor);
      }
      const at = bitmap.offset + y * (bitmap.stride | 0) + x * 4;
      bitmapWrite16(bitmap, at, outputX);
      bitmapWrite16(bitmap, at + 2, outputY);
    }
  }
  return 0;
}
