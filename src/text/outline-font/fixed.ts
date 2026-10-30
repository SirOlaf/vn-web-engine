/** 16.16 and 26.6 fixed-point helpers with the 32-bit integer semantics of FreeType 2.4.8's
 * portable `ftcalc.c` paths (no 64-bit integer type). Every result is a signed 32-bit value.
 */

/** Unsigned 64-bit `hi:lo` divided by `y`, saturating to 0x7fffffff when the quotient overflows. */
function div64by32(hi: number, lo: number, y: number): number {
  let r = hi >>> 0,
    q = 0;
  if (r >= y) return 0x7fffffff;
  for (let i = 32; i > 0; i--) {
    r = ((r << 1) | (lo >>> 31)) >>> 0;
    q = (q << 1) >>> 0;
    if (r >= y) {
      r = (r - y) >>> 0;
      q = (q | 1) >>> 0;
    }
    lo = (lo << 1) >>> 0;
  }
  return q;
}

/** Unsigned 32×32 → 64 product, returned through `wide`. */
const wide = new Uint32Array(2);
function mulTo64(x: number, y: number): void {
  const lo1 = x & 0xffff,
    hi1 = x >>> 16,
    lo2 = y & 0xffff,
    hi2 = y >>> 16;
  let lo = Math.imul(lo1, lo2) >>> 0,
    i1 = Math.imul(lo1, hi2) >>> 0;
  const i2 = Math.imul(lo2, hi1) >>> 0;
  let hi = Math.imul(hi1, hi2) >>> 0;
  i1 = (i1 + i2) >>> 0;
  hi = (hi + ((i1 < i2 ? 1 : 0) << 16)) >>> 0;
  hi = (hi + (i1 >>> 16)) >>> 0;
  i1 = (i1 << 16) >>> 0;
  lo = (lo + i1) >>> 0;
  hi = (hi + (lo < i1 ? 1 : 0)) >>> 0;
  wide[0] = lo;
  wide[1] = hi;
}

const abs32 = (a: number): number => (a < 0 ? -a | 0 : a);

/** `FT_MulFix`: (a × b + 0x8000) >> 16 with sign-magnitude rounding. */
export function mulFix(a: number, b: number): number {
  if (a === 0 || b === 0x10000) return a;
  const s = a ^ b;
  let ua = abs32(a) >>> 0;
  const ub = abs32(b) >>> 0;
  if (ua <= 2048 && ub <= 1048576) ua = (ua * ub + 0x8000) >>> 16;
  else {
    const al = ua & 0xffff;
    ua =
      (Math.imul(ua >>> 16, ub) +
        Math.imul(al, ub >>> 16) +
        ((Math.imul(al, ub & 0xffff) + 0x8000) >>> 16)) >>>
      0;
  }
  return s < 0 ? -ua | 0 : ua | 0;
}

/** `FT_MulDiv`: (a × b + c / 2) / c with sign-magnitude rounding; 0x7fffffff on overflow. */
export function mulDiv(a: number, b: number, c: number): number {
  if (a === 0 || b === c) return a;
  const s = a ^ b ^ c;
  a = abs32(a);
  b = abs32(b);
  c = abs32(c);
  if (a <= 46340 && b <= 46340 && c <= 176095 && c > 0) a = Math.trunc((a * b + (c >> 1)) / c);
  else if (c > 0) {
    mulTo64(a >>> 0, b >>> 0);
    const add = (c >> 1) >>> 0,
      lo = (wide[0]! + add) >>> 0,
      hi = (wide[1]! + (lo < add ? 1 : 0)) >>> 0;
    a = div64by32(hi, lo, c >>> 0) | 0;
  } else a = 0x7fffffff;
  return s < 0 ? -a | 0 : a;
}

/** `FT_DivFix`: (a << 16) / b with sign-magnitude rounding; 0x7fffffff for b = 0. */
export function divFix(a: number, b: number): number {
  const s = a ^ b;
  a = abs32(a);
  b = abs32(b);
  let q: number;
  if (b === 0) q = 0x7fffffff;
  else if (a >> 16 === 0) q = Math.trunc(((((a << 16) + (b >> 1)) | 0) >>> 0) / (b >>> 0)) >>> 0;
  else {
    const add = (b >> 1) >>> 0,
      lo = ((a << 16) + add) >>> 0,
      hi = ((a >> 16) + (lo < add ? 1 : 0)) >>> 0;
    q = div64by32(hi, lo, b >>> 0);
  }
  return s < 0 ? -q | 0 : q | 0;
}

/** `FT_SqrtFixed`: square root of a 16.16 value. */
export function sqrtFixed(x: number): number {
  let root = 0;
  if (x > 0) {
    let remHi = 0,
      remLo = x >>> 0;
    for (let count = 24; count > 0; count--) {
      remHi = ((remHi << 2) | (remLo >>> 30)) >>> 0;
      remLo = (remLo << 2) >>> 0;
      root = (root << 1) >>> 0;
      const testDiv = ((root << 1) + 1) >>> 0;
      if (remHi >= testDiv) {
        remHi = (remHi - testDiv) >>> 0;
        root = (root + 1) >>> 0;
      }
    }
  }
  return root | 0;
}

/** `FT_RoundFix`. */
export const roundFix = (a: number): number =>
  a >= 0 ? (a + 0x8000) & ~0xffff : -((-a + 0x8000) & ~0xffff) | 0;

/** 26.6 rounding helpers (`FT_PIX_FLOOR`, `FT_PIX_ROUND`, `FT_PIX_CEIL`). */
export const pixFloor = (x: number): number => x & ~63;
export const pixRound = (x: number): number => (x + 32) & ~63;
export const pixCeil = (x: number): number => (x + 63) & ~63;

/** A 2×2 16.16 matrix in FreeType's `xx, xy, yx, yy` order. */
export interface Matrix {
  xx: number;
  xy: number;
  yx: number;
  yy: number;
}

/** `FT_Matrix_Multiply_Scaled`: b = a × b with both matrices scaled by `scaling`. */
export function multiplyScaled(a: Matrix, b: Matrix, scaling: number): void {
  const val = Math.imul(0x10000, scaling);
  const xx = (mulDiv(a.xx, b.xx, val) + mulDiv(a.xy, b.yx, val)) | 0,
    xy = (mulDiv(a.xx, b.xy, val) + mulDiv(a.xy, b.yy, val)) | 0,
    yx = (mulDiv(a.yx, b.xx, val) + mulDiv(a.yy, b.yx, val)) | 0,
    yy = (mulDiv(a.yx, b.xy, val) + mulDiv(a.yy, b.yy, val)) | 0;
  b.xx = xx;
  b.xy = xy;
  b.yx = yx;
  b.yy = yy;
}

/** `FT_Vector_Transform_Scaled` applied to `v[0..1]`. */
export function transformScaled(v: Int32Array, i: number, m: Matrix, scaling: number): void {
  const val = Math.imul(0x10000, scaling),
    x = v[i]!,
    y = v[i + 1]!;
  v[i] = mulDiv(x, m.xx, val) + mulDiv(y, m.xy, val);
  v[i + 1] = mulDiv(x, m.yx, val) + mulDiv(y, m.yy, val);
}

/** `FT_Vector_Transform` on the point pair at `v[i], v[i + 1]`. */
export function transform(v: Int32Array, i: number, m: Matrix): void {
  const x = v[i]!,
    y = v[i + 1]!;
  v[i] = mulFix(x, m.xx) + mulFix(y, m.xy);
  v[i + 1] = mulFix(x, m.yx) + mulFix(y, m.yy);
}
