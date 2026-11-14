import {emoteBuild, EMOTEDRIVER_X86_SHA256, EMOTEDRIVER_X64_SHA256} from '../../build.js';
import {EmoteUnsupportedError} from '../errors.js';
import type {EmoteEasingCurve} from '../../../../formats/kirikiri/emote-model.js';
import type {FrameSlot} from './frame.js';
import type {EmoteTransformState} from './layer.js';

/**
 * Keyframe interpolation and easing of `MMotionPlayer` (`emotedriver.dll`, SHA-256
 * `a3b693b6…5e70b3a86`). These are x87 routines: values are computed in double and rounded
 * with `Math.fround` where the native code stores a float.
 */

const f = Math.fround;
const EPSILON = f(2 ** -23);
function x64Image(sha?: string): boolean {
  if (sha === undefined || sha === EMOTEDRIVER_X86_SHA256) return false;
  return sha === EMOTEDRIVER_X64_SHA256 || emoteBuild(sha) === EMOTEDRIVER_X64_SHA256;
}
function weight(curve: CurveCursor | null, t: number, x64: boolean): number {
  if (x64 && curve) throw new EmoteUnsupportedError('easing curves');
  return curve ? curve.evaluate(t) : t;
}

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
export function lerp(
  curve: CurveCursor | null,
  a: number,
  b: number,
  t: number,
  driverSha256?: string,
): number {
  const x64 = x64Image(driverSha256);
  if (b === a) return a;
  const k = weight(curve, t, x64);
  return x64 ? f(f(1 - k) * a + k * b) : f(k * b + (1 - k) * a);
}

/** 0x1002a9f0: angle in degrees along the shorter arc, wrapped to [0, 360]. */
export function lerpAngle(
  curve: CurveCursor | null,
  a: number,
  b: number,
  t: number,
  driverSha256?: string,
): number {
  const x64 = x64Image(driverSha256);
  if (b === a) return a;
  if (b <= a) {
    if (a - b > 180) b = f(360 + b);
  } else if (b - a > 180) b = f(b - 360);
  const r = lerp(curve, a, b, t, driverSha256);
  if (r < 0) return f(r + 360);
  return (x64 ? r >= 360 : r > 360) ? f(r - 360) : r;
}

/**
 * 0x1002aac0: ARGB lerp with an 8-bit weight `trunc(t·256)` (integer arithmetic of the
 * native code, including its 0xffff00ff mask on the high pair).
 */
export function lerpColor(
  curve: CurveCursor | null,
  a: number,
  b: number,
  t: number,
  driverSha256?: string,
): number {
  const x64 = x64Image(driverSha256);
  if (a === b) return a;
  const k = weight(curve, t, x64);
  if (x64) {
    const w = Math.trunc(f(k * 256)),
      inv = 256 - w;
    const lo = (((b & 0xff00ff) >>> 0) * w + ((a & 0xff00ff) >>> 0) * inv) / 256;
    const hi = ((a >>> 8) & 0xff00ff) * inv + ((b >>> 8) & 0xff00ff) * w;
    return ((Math.floor(lo) & 0xff00ff) | (hi & 0xff00ff00)) >>> 0;
  }
  const rounded = f(k);
  const w = Math.trunc(rounded * 256) | 0,
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
  driverSha256?: string,
): void {
  const x64 = x64Image(driverSha256);
  if (b[0] === a[0] && b[1] === a[1] && b[2] === a[2]) {
    out[at] = a[0]!;
    out[at + 1] = a[1]!;
    out[at + 2] = a[2]!;
    return;
  }
  const k = curve ? f(weight(curve, t, x64)) : t,
    s = x64 ? f(1 - k) : 1 - k;
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
  driverSha256?: string,
): void {
  const x64 = x64Image(driverSha256);
  const k = x64 ? weight(curve, t, true) : f(weight(curve, t, false)),
    s = f(1 - k);
  if (x64) {
    if (Math.abs(k) >= EPSILON) for (let i = 0; i < a.length; i++) out[i] = b[i]! * k + s * a[i]!;
    else out.set(a);
    return;
  }
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

/** Empty native patch pointer; frame slots and scalar evaluation share this identity. */
export const EMPTY_PATCH = new Float32Array(0);

/** Only slot values consumed by interpolation, independent of slot allocation/loading. */
type EmoteInterpolationFrame = Pick<
  FrameSlot,
  | 'empty'
  | 'tween'
  | 'time'
  | 'ti'
  | 'fx'
  | 'fy'
  | 'angle'
  | 'zx'
  | 'zy'
  | 'sx'
  | 'sy'
  | 'coord'
  | 'opa'
  | 'singleColor'
  | 'colorUnset'
  | 'colors'
  | 'meshPatch'
  | 'eased'
  | 'coordCurve'
  | 'colorCurve'
  | 'angleCurve'
  | 'zoomCurve'
  | 'slantCurve'
  | 'meshCurve'
>;

type EmoteFrameTransform = Pick<
  EmoteTransformState,
  | 'flipX'
  | 'flipY'
  | 'angle'
  | 'zoomX'
  | 'zoomY'
  | 'slantX'
  | 'slantY'
  | 'x'
  | 'y'
  | 'z'
  | 'opacity'
>;

export interface EmoteFrameClock {
  readonly time: number;
}

/** State-block storage of the a3b693b6…5e70b3a86 image. */
export interface EmoteBlockFrameNode {
  readonly cur: EmoteInterpolationFrame;
  readonly next: EmoteInterpolationFrame;
  readonly framesDirty: boolean;
  readonly parameter: {readonly position: number} | null;
  readonly state: EmoteFrameTransform;
  lastT: number;
  singleColor: boolean;
  colorUnset: boolean;
  readonly colors: Uint32Array;
  readonly mesh: {local: Float32Array} | null;
}

/** Scalar storage of the 80d28bd0…1e051 image; no per-node layout adapter. */
export interface EmoteScalarFrameNode extends EmoteFrameTransform {
  readonly cur: EmoteInterpolationFrame;
  readonly next: EmoteInterpolationFrame;
  readonly framesDirty: boolean;
  readonly param: {readonly value: number} | null;
  prevE: number;
  scalarColor: boolean;
  defaultColor: boolean;
  readonly colors: Uint32Array;
  readonly meshKind: number;
  readonly combinatorOwned: boolean;
  readonly mstate: {bp: Float32Array | null} | null;
}

// Preserve the x86 literal comparison, which differs from a rounded float epsilon.
const BLOCK_EPSILON = 1.1920929e-7;

/**
 * 0x1003e1a0: evaluates the node's current frame into its state. Returns whether the node
 * changed (always when `force` or the frames were reloaded).
 */
export function evaluateBlockFrame(
  clip: EmoteFrameClock,
  node: EmoteBlockFrameNode,
  force: boolean,
): boolean {
  const cur = node.cur,
    next = node.next,
    s = node.state;
  let changed = force || node.framesDirty;
  if (cur.empty) return changed;
  if (cur.tween && !next.empty) {
    const now = node.parameter ? node.parameter.position : clip.time;
    let d = f(now - cur.time);
    if (cur.ti !== 0) {
      const ti = cur.ti >>> 0;
      d = f((Math.imul(roundHalfEven(d / f(ti)), ti) >>> 0) as number);
    }
    const t = f(d / f(next.time - cur.time));
    if (Math.abs(t) >= BLOCK_EPSILON) {
      if (!changed && Math.abs(f(node.lastT - t)) < BLOCK_EPSILON) return false;
      node.lastT = t;
      s.flipX = cur.fx;
      s.flipY = cur.fy;
      s.angle = lerpAngle(cur.angleCurve, cur.angle, next.angle, t);
      s.zoomX = lerp(cur.zoomCurve, cur.zx, next.zx, t);
      s.zoomY = lerp(cur.zoomCurve, cur.zy, next.zy, t);
      s.slantX = lerp(cur.slantCurve, cur.sx, next.sx, t);
      s.slantY = lerp(cur.slantCurve, cur.sy, next.sy, t);
      const xyz = [0, 0, 0];
      lerpCoord(cur.coordCurve, cur.coord, next.coord, t, xyz, 0);
      s.x = xyz[0]!;
      s.y = xyz[1]!;
      s.z = xyz[2]!;
      const u = f(1 - t);
      s.opacity = roundHalfAway(f((cur.opa >>> 0) * u + (next.opa >>> 0) * t));
      node.singleColor = cur.singleColor && next.singleColor;
      node.colorUnset = cur.colorUnset && next.colorUnset;
      if (!node.singleColor)
        for (let k = 0; k < 4; k++)
          node.colors[k] = lerpColor(cur.colorCurve, cur.colors[k]!, next.colors[k]!, t);
      else node.colors.fill(lerpColor(cur.colorCurve, cur.colors[0]!, next.colors[0]!, t));
      if (node.mesh) {
        const a = cur.meshPatch,
          b = next.meshPatch;
        if (a.length === 0 && b.length === 0) node.mesh.local = new Float32Array(0);
        else {
          const from = a.length ? a : IDENTITY_PATCH,
            to = b.length ? b : IDENTITY_PATCH;
          if (node.mesh.local.length !== from.length)
            node.mesh.local = new Float32Array(from.length);
          lerpPatch(cur.meshCurve, from, to, t, node.mesh.local);
        }
      }
      return true;
    }
    if (Math.abs(f(node.lastT - t)) >= BLOCK_EPSILON) changed = true;
    node.lastT = t;
  }
  if (!changed) return false;
  s.flipX = cur.fx;
  s.flipY = cur.fy;
  s.angle = f(cur.angle);
  s.zoomX = f(cur.zx);
  s.zoomY = f(cur.zy);
  s.slantX = f(cur.sx);
  s.slantY = f(cur.sy);
  s.x = f(cur.coord[0]!);
  s.y = f(cur.coord[1]!);
  s.z = f(cur.coord[2]!);
  node.colors.set(cur.colors);
  s.opacity = cur.opa >>> 0;
  node.singleColor = cur.singleColor;
  node.colorUnset = cur.colorUnset;
  if (node.mesh) node.mesh.local = cur.meshPatch.slice();
  return true;
}

/** 0x1800422f0 (80d28bd0…1e051): scalar frame evaluation, including native patch ownership. */
export function evaluateScalarFrame(
  clip: EmoteFrameClock,
  n: EmoteScalarFrameNode,
  force: boolean,
): boolean {
  force ||= n.framesDirty;
  const A = n.cur,
    B = n.next;
  if (A.empty) return force;
  if (A.tween && !B.empty) {
    let e = f((n.param ? n.param.value : clip.time) - A.time);
    if (A.ti) e = f(Math.trunc(f(e / A.ti)) * A.ti);
    e = f(e / f(B.time - A.time));
    if (Math.abs(e) >= EPSILON) {
      if (!force && Math.abs(f(n.prevE - e)) < EPSILON) return false;
      if (A.eased) throw new EmoteUnsupportedError('easing curves');
      n.prevE = e;
      n.flipX = A.fx;
      n.flipY = A.fy;
      n.angle = lerpAngle(null, A.angle, B.angle, e, EMOTEDRIVER_X64_SHA256);
      n.zoomX = lerp(null, A.zx, B.zx, e, EMOTEDRIVER_X64_SHA256);
      n.zoomY = lerp(null, A.zy, B.zy, e, EMOTEDRIVER_X64_SHA256);
      n.slantX = lerp(null, A.sx, B.sx, e, EMOTEDRIVER_X64_SHA256);
      n.slantY = lerp(null, A.sy, B.sy, e, EMOTEDRIVER_X64_SHA256);
      const ie = f(1 - e);
      if (A.coord[0] === B.coord[0] && A.coord[1] === B.coord[1] && A.coord[2] === B.coord[2]) {
        n.x = A.coord[0];
        n.y = A.coord[1];
        n.z = A.coord[2];
      } else {
        n.x = f(ie * A.coord[0] + e * B.coord[0]);
        n.y = f(ie * A.coord[1] + e * B.coord[1]);
        n.z = f(ie * A.coord[2] + e * B.coord[2]);
      }
      const o = f(f(A.opa * ie) + f(B.opa * e));
      n.opacity = Math.trunc(o < 0 ? Math.ceil(o - 0.5) : Math.floor(o + 0.5)) >>> 0;
      n.scalarColor = A.singleColor && B.singleColor;
      n.defaultColor = A.colorUnset && B.colorUnset;
      if (!n.scalarColor)
        for (let i = 0; i < 4; i++)
          n.colors[i] = lerpColor(null, A.colors[i]!, B.colors[i]!, e, EMOTEDRIVER_X64_SHA256);
      else n.colors.fill(lerpColor(null, A.colors[0]!, B.colors[0]!, e, EMOTEDRIVER_X64_SHA256));
      if (n.meshKind === 1 && !n.combinatorOwned && n.mstate) {
        if (A.meshPatch === EMPTY_PATCH && B.meshPatch === EMPTY_PATCH) n.mstate.bp = null;
        else {
          const patch = new Float32Array(32);
          lerpPatch(
            null,
            A.meshPatch === EMPTY_PATCH ? IDENTITY_PATCH : A.meshPatch,
            B.meshPatch === EMPTY_PATCH ? IDENTITY_PATCH : B.meshPatch,
            e,
            patch,
            EMOTEDRIVER_X64_SHA256,
          );
          n.mstate.bp = patch;
        }
      }
      return true;
    }
    const old = n.prevE;
    n.prevE = e;
    if (Math.abs(f(old - e)) >= EPSILON) force = true;
  }
  if (!force) return false;
  n.flipX = A.fx;
  n.flipY = A.fy;
  n.angle = A.angle;
  n.zoomX = A.zx;
  n.zoomY = A.zy;
  n.slantX = A.sx;
  n.slantY = A.sy;
  n.x = A.coord[0];
  n.y = A.coord[1];
  n.z = A.coord[2];
  for (let i = 0; i < 4; i++) n.colors[i] = A.colors[i]!;
  n.opacity = A.opa;
  n.scalarColor = A.singleColor;
  n.defaultColor = A.colorUnset;
  if (n.meshKind === 1 && !n.combinatorOwned && n.mstate)
    n.mstate.bp = A.meshPatch === EMPTY_PATCH ? null : A.meshPatch;
  return true;
}
