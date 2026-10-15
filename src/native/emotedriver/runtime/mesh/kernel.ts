import type {EmoteMeshKernel} from '../interfaces.js';

/**
 * TypeScript twin of the `wasm/emote-mesh` kernel: the per-vertex loops of the mesh pass
 * (0x1003f9c0) in `emotedriver.dll` (SHA-256 `a3b693b6…5e70b3a86`).
 *
 * The native build selects its SSE paths when the CPU has SSE (0x10028200 sets 0x100875f3),
 * which every supported machine has. Those paths compute in single precision, so every
 * operation below rounds with `Math.fround`, in the native operand order. The Bernstein
 * tables (0x100286d0) and the quad subdivision (0x1002d960) are x87 code: products and sums
 * run in double here and are rounded where the native code stores a float. The Rust kernel
 * performs the same operations, so both produce identical bits.
 */

const f = Math.fround;

/**
 * Cubic Bernstein weights for `segments + 1` samples t = i / segments (0x100286d0), four per
 * sample: (1-t)³, 3(1-t)²t, 3(1-t)t², t³.
 */
export function bernsteinTable(segments: number): Float32Array {
  const out = new Float32Array((segments + 1) * 4),
    n = f(segments);
  for (let i = 0; i <= segments; i++) {
    const t = f(i / n),
      s = f(1 - t);
    out[i * 4] = s * s * s;
    out[i * 4 + 1] = s * s * t * 3;
    out[i * 4 + 2] = 3 * (s * t * t);
    out[i * 4 + 3] = t * t * t;
  }
  return out;
}

/**
 * One grid point of a world-space patch: the SSE accumulation of 0x1002cd90 and 0x1003f680.
 * `u` and `v` hold the four Bernstein weights. Returns x and y in `out[at]`, `out[at + 1]`.
 */
function patchPoint(
  cp: Float32Array,
  u: Float32Array,
  uAt: number,
  v: Float32Array,
  vAt: number,
  out: Float32Array,
  at: number,
): void {
  // Lanes k = 0..3 accumulate column k over the rows r: acc = (X[r][k]·u_k)·v_r + acc.
  let x0 = 0,
    x1 = 0,
    x2 = 0,
    x3 = 0,
    y0 = 0,
    y1 = 0,
    y2 = 0,
    y3 = 0;
  const u0 = u[uAt]!,
    u1 = u[uAt + 1]!,
    u2 = u[uAt + 2]!,
    u3 = u[uAt + 3]!;
  for (let r = 0; r < 4; r++) {
    const w = v[vAt + r]!,
      p = r * 8;
    if (r === 0) {
      x0 = f(f(cp[p]! * u0) * w);
      x1 = f(f(cp[p + 2]! * u1) * w);
      x2 = f(f(cp[p + 4]! * u2) * w);
      x3 = f(f(cp[p + 6]! * u3) * w);
      y0 = f(f(cp[p + 1]! * u0) * w);
      y1 = f(f(cp[p + 3]! * u1) * w);
      y2 = f(f(cp[p + 5]! * u2) * w);
      y3 = f(f(cp[p + 7]! * u3) * w);
    } else {
      x0 = f(f(f(cp[p]! * u0) * w) + x0);
      x1 = f(f(f(cp[p + 2]! * u1) * w) + x1);
      x2 = f(f(f(cp[p + 4]! * u2) * w) + x2);
      x3 = f(f(f(cp[p + 6]! * u3) * w) + x3);
      y0 = f(f(f(cp[p + 1]! * u0) * w) + y0);
      y1 = f(f(f(cp[p + 3]! * u1) * w) + y1);
      y2 = f(f(f(cp[p + 5]! * u2) * w) + y2);
      y3 = f(f(f(cp[p + 7]! * u3) * w) + y3);
    }
  }
  // shufps 0x88/0xdd pairs lanes (0,1) and (2,3), then adds the pair sums.
  out[at] = f(f(x3 + x2) + f(x1 + x0));
  out[at + 1] = f(f(y3 + y2) + f(y1 + y0));
}

/** SSE Bernstein weights of one coordinate (0x1003f680): lanes 1, 3(1-t), 3(1-t), t. */
function inlineWeights(t: number, out: Float32Array, at: number): void {
  const s = f(1 - t);
  out[at] = f(f(s * s) * s);
  out[at + 1] = f(f(f(3 * s) * s) * t);
  out[at + 2] = f(f(f(3 * s) * t) * t);
  out[at + 3] = f(f(t * t) * t);
}

/** 0x1002cd90 grid loop: (columns + 1) × (rows + 1) points from Bernstein tables. */
export function evaluatePatch(
  controlPoints: Float32Array,
  columns: number,
  rows: number,
  out: Float32Array,
): void {
  const u = bernsteinTable(columns),
    v = bernsteinTable(rows);
  let at = 0;
  for (let j = 0; j <= rows; j++)
    for (let i = 0; i <= columns; i++, at += 2)
      patchPoint(controlPoints, u, i * 4, v, j * 4, out, at);
}

/** 0x1003f680: points through the inverse patch frame, then the patch. */
export function deformPoints(
  controlPoints: Float32Array,
  inverse: Float32Array,
  translateX: number,
  translateY: number,
  points: Float32Array,
  count: number,
): void {
  const w = new Float32Array(8),
    i0 = inverse[0]!,
    i1 = inverse[1]!,
    i2 = inverse[2]!,
    i3 = inverse[3]!;
  for (let k = 0; k < count; k++) {
    const a = f(points[k * 2]! + translateX),
      b = f(points[k * 2 + 1]! + translateY);
    inlineWeights(f(i0 * a + i1 * b), w, 0);
    inlineWeights(f(i2 * a + i3 * b), w, 4);
    patchPoint(controlPoints, w, 0, w, 4, points, k * 2);
  }
}

/** 0x1002d960: bilinear grid over a quad; every intermediate is stored as float. */
export function subdivideQuad(
  corners: Float32Array,
  columns: number,
  rows: number,
  out: Float32Array,
): void {
  const invC = f(1 / columns),
    invR = f(1 / rows);
  let at = 0;
  for (let j = 0; j <= rows; j++) {
    const t = f(j * invR),
      s = f(1 - t);
    const lx = f(f(corners[4]! * t) + f(s * corners[0]!)),
      ly = f(f(t * corners[5]!) + f(s * corners[1]!)),
      rx = f(f(s * corners[2]!) + f(corners[6]! * t)),
      ry = f(f(s * corners[3]!) + f(t * corners[7]!));
    for (let i = 0; i <= columns; i++, at += 2) {
      const uu = f(i * invC),
        su = f(1 - uu);
      out[at] = f(f(lx * su) + f(rx * uu));
      out[at + 1] = f(f(su * ly) + f(ry * uu));
    }
  }
}

/** The TypeScript kernel. */
export const emoteMeshKernelJs: EmoteMeshKernel = {evaluatePatch, deformPoints, subdivideQuad};
