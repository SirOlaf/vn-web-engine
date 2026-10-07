import type {EmoteEasingCurve} from '../../../../formats/kirikiri/emote-model.js';

/**
 * Keyframe interpolation and easing of `MMotionPlayer` (`emotedriver.dll`, SHA-256
 * `a3b693b6…5e70b3a86`). These are x87 routines: values are computed in double and rounded
 * with `Math.fround` where the native code stores a float.
 */

const f = Math.fround;

/** A curve reference with its search cursor (slot +0x64.. 16-byte entries: curve, segment, point). */
export class CurveCursor {
  segment = 0;
  point = 0;
  constructor(readonly curve: EmoteEasingCurve) {}

  /**
   * 0x10029230: natural cubic spline through the curve points, `p` holding the second
   * derivatives. The cursor moves across segments and points as the native search does.
   */
  evaluate(t: number): number {
    const segments = this.curve;
    const lastX = (s: number) => {
      const pts = segments[s]!.points;
      return pts[pts.length - 1]!.x;
    };
    while (lastX(this.segment) < t) {
      this.segment++;
      this.point = 0;
    }
    while (t < segments[this.segment]!.points[0]!.x) {
      this.segment--;
      this.point = segments[this.segment]!.points.length - 2;
    }
    const pts = segments[this.segment]!.points;
    while (pts[this.point + 1]!.x < t) this.point++;
    while (t < pts[this.point]!.x) this.point--;
    const a = pts[this.point]!,
      b = pts[this.point + 1]!;
    const h = f(b.x - a.x),
      u = f((t - a.x) / h),
      v = f(1 - u);
    return f((((u * u * u - u) * b.p + (v * v * v - v) * a.p) * h * h) / 6 + b.y * u + a.y * v);
  }
}

/** 0x1002a990: `curve ? curve(t) : t`, then `t·b + (1-t)·a`; equal endpoints return `a`. */
export function lerp(curve: CurveCursor | null, a: number, b: number, t: number): number {
  if (b === a) return a;
  const k = curve ? curve.evaluate(t) : t;
  return f(k * b + (1 - k) * a);
}

/** 0x1002a9f0: angle in degrees along the shorter arc, wrapped to [0, 360]. */
export function lerpAngle(curve: CurveCursor | null, a: number, b: number, t: number): number {
  if (b === a) return a;
  if (b <= a) {
    if (a - b > 180) b = f(360 + b);
  } else if (b - a > 180) b = f(b - 360);
  const r = lerp(curve, a, b, t);
  if (r < 0) return f(r + 360);
  return r > 360 ? f(r - 360) : r;
}

/**
 * 0x1002aac0: ARGB lerp with an 8-bit weight `trunc(t·256)` (integer arithmetic of the
 * native code, including its 0xffff00ff mask on the high pair).
 */
export function lerpColor(curve: CurveCursor | null, a: number, b: number, t: number): number {
  if (a === b) return a;
  const k = curve ? f(curve.evaluate(t)) : f(t);
  const w = Math.trunc(k * 256) | 0,
    inv = (256 - w) | 0;
  const hi = (Math.imul((a >>> 8) & 0xffff00ff, inv) + Math.imul((b >>> 8) & 0xffff00ff, w)) >>> 0;
  const lo = (Math.imul(a & 0xff00ff, inv) + Math.imul(b & 0xff00ff, w)) >>> 8;
  const mid = (Math.imul((a >>> 8) & 0xff00ff, inv) + Math.imul((b >>> 8) & 0xff00ff, w)) >>> 0;
  return ((((hi ^ lo) & 0xff00ff) ^ mid) >>> 0) as number;
}

/**
 * 0x1002acd0: coordinate lerp. `path` (content `cp`, 0x1002a590) bends the move; NEKOPARA
 * has no `cp`, and the reader rejects it before evaluation.
 */
export function lerpCoord(
  curve: CurveCursor | null,
  a: readonly number[],
  b: readonly number[],
  t: number,
  out: Float32Array | number[],
  at: number,
): void {
  if (b[0] === a[0] && b[1] === a[1] && b[2] === a[2]) {
    out[at] = a[0]!;
    out[at + 1] = a[1]!;
    out[at + 2] = a[2]!;
    return;
  }
  const k = curve ? f(curve.evaluate(t)) : t,
    s = 1 - k;
  out[at] = f(a[0]! * s + b[0]! * k);
  out[at + 1] = f(a[1]! * s + b[1]! * k);
  out[at + 2] = f(s * a[2]! + b[2]! * k);
}

/** 0x10027fa0: rounds half away from zero (`floor(x + 0.5)` / `ceil(x - 0.5)`). */
export function roundHalfAway(x: number): number {
  return x >= 0 ? Math.floor(f(x + 0.5)) : Math.ceil(f(x - 0.5));
}

/** `fistp` under the default control word: round half to even. */
export function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** `_ftol` (0x10068690): truncation toward zero. */
export const truncate = Math.trunc;

/** The unit patch (0x10028060): control point i at ((i & 3) / 3, (i >> 2) / 3). */
export const IDENTITY_PATCH: Float32Array = (() => {
  const p = new Float32Array(32);
  for (let i = 0; i < 16; i++) {
    p[i * 2] = (i & 3) / 3;
    p[i * 2 + 1] = (i >> 2) / 3;
  }
  return p;
})();

/**
 * 0x1002aef0: patch lerp, SSE path (single precision): `a·(1-t) + b·t` per float; the count
 * comes from `a`.
 */
export function lerpPatch(
  curve: CurveCursor | null,
  a: Float32Array,
  b: Float32Array,
  t: number,
  out: Float32Array,
): void {
  const k = f(curve ? curve.evaluate(t) : t),
    s = f(1 - k);
  for (let i = 0; i < a.length; i++) out[i] = f(f(a[i]! * s) + f(b[i]! * k));
}

/**
 * 0x1002b320: one point of a patch, SSE path. Lanes pair x and y of two columns: weights
 * (u) [B0, B0, B1, B1] and [B2, B2, B3, B3]; rows (v) accumulate, then lanes 0 and 2 add.
 */
export function patchPoint(
  cp: Float32Array,
  u: number,
  v: number,
  out: Float32Array | number[],
  at = 0,
): void {
  const iu = f(1 - u),
    iv = f(1 - v);
  const b0 = f(f(iu * iu) * iu),
    b1 = f(f(f(3 * iu) * iu) * u),
    b2 = f(f(f(3 * iu) * u) * u),
    b3 = f(f(u * u) * u);
  const w0 = f(f(iv * iv) * iv),
    w1 = f(f(f(3 * iv) * iv) * v),
    w2 = f(f(f(3 * iv) * v) * v),
    w3 = f(f(v * v) * v);
  const w = [w0, w1, w2, w3];
  let x0 = 0,
    y0 = 0,
    x1 = 0,
    y1 = 0;
  for (let r = 0; r < 4; r++) {
    const p = r * 8;
    const sx0 = f(f(cp[p]! * b0) + f(cp[p + 4]! * b2)),
      sy0 = f(f(cp[p + 1]! * b0) + f(cp[p + 5]! * b2)),
      sx1 = f(f(cp[p + 2]! * b1) + f(cp[p + 6]! * b3)),
      sy1 = f(f(cp[p + 3]! * b1) + f(cp[p + 7]! * b3));
    const wr = w[r]!;
    if (r === 0) {
      x0 = f(sx0 * wr);
      y0 = f(sy0 * wr);
      x1 = f(sx1 * wr);
      y1 = f(sy1 * wr);
    } else {
      x0 = f(f(wr * sx0) + x0);
      y0 = f(f(wr * sy0) + y0);
      x1 = f(f(wr * sx1) + x1);
      y1 = f(f(wr * sy1) + y1);
    }
  }
  out[at] = f(x1 + x0);
  out[at + 1] = f(y1 + y0);
}
