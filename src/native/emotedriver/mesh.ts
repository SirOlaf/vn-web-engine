/**
 * Bezier-patch and interpolation helpers of the E-mote 3.9.8 clip (`emotedriver.dll` x64,
 * SHA-256 `80d28bd0…1e051`). A patch is 16 control points stored as 32 floats (x, y pairs,
 * index = row·4 + column); patch space is the unit square of the layer's source rectangle.
 */

const f32 = Math.fround;

/** `DAT_181fcd510`: the clip's epsilon for interpolation weights. */
export const FLT_EPSILON = f32(2 ** -23);

/** `DAT_181fe39f8` (initialized at 0x18002d460): the identity patch, x = column/3, y = row/3. */
export const DEFAULT_MESH: Float32Array = (() => {
  const m = new Float32Array(32);
  for (let i = 0; i < 16; i++) {
    m[i * 2] = (i & 3) / 3;
    m[i * 2 + 1] = (i >> 2) / 3;
  }
  return m;
})();

const basisCache = new Map<number, Float32Array>();

/**
 * 0x18002df10: `n + 1` samples of the cubic Bernstein basis at t = i/n, four weights each
 * ([(1−t)³, 3(1−t)²t, 3(1−t)t², t³]).
 */
export function bezierBasis(n: number): Float32Array {
  let b = basisCache.get(n);
  if (b) return b;
  b = new Float32Array((n + 1) * 4);
  for (let i = 0; i <= n; i++) {
    const t = f32(i / n);
    const s = f32(1 - t);
    b[i * 4] = s * s * s;
    b[i * 4 + 1] = 3 * s * s * t;
    b[i * 4 + 2] = 3 * s * t * t;
    b[i * 4 + 3] = t * t * t;
  }
  basisCache.set(n, b);
  return b;
}

function bernstein(t: number, out: Float64Array): void {
  const s = 1 - t;
  out[0] = s * s * s;
  out[1] = 3 * s * s * t;
  out[2] = 3 * s * t * t;
  out[3] = t * t * t;
}

const bu = new Float64Array(4);
const bv = new Float64Array(4);

/**
 * 0x180058320: maps `count` points (x = u, y = v) in place through the patch `cp`
 * (Σ cp[r·4 + c]·B_c(u)·B_r(v)).
 */
export function bezierMap(points: Float32Array, count: number, cp: Float32Array, offset = 0): void {
  for (let k = 0; k < count; k++) {
    const o = offset + k * 2;
    bernstein(points[o]!, bu);
    bernstein(points[o + 1]!, bv);
    let x = 0,
      y = 0;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        const w = bu[c]! * bv[r]!;
        x += cp[(r * 4 + c) * 2]! * w;
        y += cp[(r * 4 + c) * 2 + 1]! * w;
      }
    }
    points[o] = x;
    points[o + 1] = y;
  }
}

/** 0x180058320 for one point. */
export function bezierPoint(cp: Float32Array, u: number, v: number): [number, number] {
  const p = new Float32Array([u, v]);
  bezierMap(p, 1, cp);
  return [p[0]!, p[1]!];
}

/** 0x180058130: p = M·(p + off) for `count` points in place; M is row-major [a, b, c, d]. */
export function affineMap(
  points: Float32Array,
  count: number,
  m: ArrayLike<number>,
  ox: number,
  oy: number,
): void {
  for (let k = 0; k < count; k++) {
    const x = points[k * 2]! + ox,
      y = points[k * 2 + 1]! + oy;
    points[k * 2] = m[0]! * x + m[1]! * y;
    points[k * 2 + 1] = m[2]! * x + m[3]! * y;
  }
}

/**
 * 0x1800586f0: tessellates the patch `cp` mapped by the affine `ms` [a, b, c, d] plus
 * (tx, ty) into a (rows + 1)·(cols + 1) grid, rows outer.
 */
export function tessellate(
  cp: Float32Array,
  cols: number,
  rows: number,
  ms: ArrayLike<number>,
  tx: number,
  ty: number,
): Float32Array {
  const px = new Float64Array(16),
    py = new Float64Array(16);
  for (let i = 0; i < 16; i++) {
    const x = cp[i * 2]!,
      y = cp[i * 2 + 1]!;
    px[i] = f32(ms[0]! * x + ms[1]! * y + tx);
    py[i] = f32(ms[2]! * x + ms[3]! * y + ty);
  }
  const bc = bezierBasis(cols),
    br = bezierBasis(rows);
  const out = new Float32Array((rows + 1) * (cols + 1) * 2);
  let o = 0;
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      let x = 0,
        y = 0;
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          const w = bc[i * 4 + c]! * br[j * 4 + r]!;
          x += px[r * 4 + c]! * w;
          y += py[r * 4 + c]! * w;
        }
      }
      out[o++] = x;
      out[o++] = y;
    }
  }
  return out;
}

/** 0x180030130: scalar lerp, only when the ends differ. */
export function lerpScalar(a: number, b: number, e: number): number {
  return a !== b ? f32(f32(1 - e) * a + e * b) : a;
}

/** 0x180030190: angle lerp in degrees along the short way, wrapped to [0, 360). */
export function lerpAngle(a: number, b: number, e: number): number {
  if (a === b) return a;
  if (b <= a) {
    if (a - b > 180) b = f32(b + 360);
  } else if (b - a > 180) b = f32(b - 360);
  let v = a;
  if (a !== b) v = f32(f32(1 - e) * a + e * b);
  if (v < 0) return f32(v + 360);
  if (v >= 360) v = f32(v - 360);
  return v;
}

/** 0x180030260: per-channel colour lerp with an 8-bit weight. */
export function lerpColor(a: number, b: number, e: number): number {
  if (a === b) return a;
  const w = Math.trunc(f32(e * 256));
  const iw = 256 - w;
  const lo = (((b & 0xff00ff) >>> 0) * w + ((a & 0xff00ff) >>> 0) * iw) / 256;
  const hi = ((a >>> 8) & 0xff00ff) * iw + ((b >>> 8) & 0xff00ff) * w;
  return ((Math.floor(lo) & 0xff00ff) | (hi & 0xff00ff00)) >>> 0;
}

/**
 * 0x180030810: colour modulation. 0x808080ff is neutral; colour channels (bytes 1–3)
 * multiply as x·y/128 clamped to 255, alpha (byte 0) as x·y/255.
 */
export function modulateColor(a: number, b: number): number {
  a >>>= 0;
  b >>>= 0;
  if (b === 0x808080ff) return a;
  if (a === 0x808080ff) return b;
  let out = Math.trunc(((a & 0xff) * (b & 0xff)) / 255);
  for (let s = 8; s < 32; s += 8) {
    const v = (((a >>> s) & 0xff) * ((b >>> s) & 0xff)) >> 7;
    out |= Math.min(255, v) << s;
  }
  return out >>> 0;
}

/** 0x180030670: patch lerp; below epsilon the first patch is copied. */
export function lerpMesh(a: Float32Array, b: Float32Array, e: number): Float32Array {
  const out = new Float32Array(32);
  if (Math.abs(e) >= FLT_EPSILON) {
    const ie = f32(1 - e);
    for (let i = 0; i < 32; i++) out[i] = b[i]! * e + ie * a[i]!;
  } else out.set(a);
  return out;
}
