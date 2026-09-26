import type {BurikoBitmap} from './bitmap.js';
import {bitmapWrite16} from './bitmap-scalar.js';
import {burikoRosettaSseReciprocal} from './cpu-numerical-profile.js';

const f32 = Math.fround;
function cvtt32(value: number): number {
  const integer = Math.trunc(value);
  return !Number.isFinite(integer) || integer < -2147483648 || integer > 2147483647
    ? -2147483648
    : integer;
}

/**032E60 fills the actual format6 descriptor without touching row padding. */
export function fillBurikoLinearVectorMap(bitmap: BurikoBitmap, direction: number): number {
  if (bitmap.format !== 6 || bitmap.width === 0 || bitmap.height === 0) return 0x80000003;
  direction >>>= 0;
  if (direction > 3) return 0x8000000a;
  const horizontal = (direction & 1) === 0,
    rowPhase = direction === 0 || direction === 3;
  for (let y = 0; y < bitmap.height >>> 0; y++) {
    const row = bitmap.offset + y * (bitmap.stride | 0);
    for (let x = 0; x < bitmap.width >>> 0; x++) {
      const at = row + (x | 0) * 6;
      bitmapWrite16(bitmap, at, horizontal ? 32767 : 0);
      bitmapWrite16(bitmap, at + 2, horizontal ? 0 : 32767);
      bitmapWrite16(bitmap, at + 4, (rowPhase ? y : x) << 2);
    }
  }
  return 0;
}

/**033020: double radius, profiled RCPSS refinement, double component products. */
export function fillBurikoRadialVectorMap(
  bitmap: BurikoBitmap,
  mode: number,
  centerX: number,
  centerY: number,
  period: number,
): number {
  if (bitmap.format !== 6 || bitmap.width === 0 || bitmap.height === 0) return 0x80000003;
  mode >>>= 0;
  if (mode > 1) return 0x80000009;
  const divisor = period >>> 0 === 0 ? 0xffffffff : (period << 2) >>> 0;
  let dy = -centerY | 0;
  for (let y = 0; y < bitmap.height >>> 0; y++, dy = (dy + 1) | 0) {
    const row = bitmap.offset + y * (bitmap.stride | 0),
      squareY = dy * dy;
    let dx = -centerX | 0;
    for (let x = 0; x < bitmap.width >>> 0; x++, dx = (dx + 1) | 0) {
      const radius = Math.sqrt(dx * dx + squareY),
        radius32 = f32(radius);
      // Zero follows SSE: +Infinity seed -> refinement NaN -> CVTT32 sentinel.
      const seed = radius32 === 0 ? Infinity : burikoRosettaSseReciprocal(radius32);
      const inverse = f32(f32(seed + seed) - f32(radius32 * f32(seed * seed)));
      const at = row + x * 6;
      bitmapWrite16(bitmap, at, cvtt32(Math.imul(mode === 0 ? dx : dy, 32767) * inverse));
      bitmapWrite16(bitmap, at + 2, cvtt32(Math.imul(mode === 0 ? dy : dx, 32767) * inverse));
      // CVTTSD2SI64 is finite/in-range for int32 coordinates. DIV32 uses its low DWORD.
      const phase = Math.trunc(radius * 4) >>> 0;
      if (divisor === 0) throw new RangeError('Buriko radial vector map divides by zero');
      bitmapWrite16(bitmap, at + 4, phase % divisor);
    }
  }
  return 0;
}
