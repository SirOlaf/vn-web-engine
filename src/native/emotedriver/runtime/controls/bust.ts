import type {EmoteBustControl} from '../../../../formats/kirikiri/emote-metadata.js';
import {f32} from './common.js';

/** Down vector of the physics (0x10086810): screen y grows downwards. */
export const EMOTE_DOWN = [0, 1, 0] as const;
/** Gust direction (0x10086814). */
export const EMOTE_WIND_AXIS = [1, 0, 0] as const;
/** Output mapping constants: float 1.15 and float π/80, stored as doubles (0x100727c0, 0x100727b8). */
export const EMOTE_ANGLE_GAIN = 1.149999976158142;
export const EMOTE_ANGLE_UNIT = 0.039269909262657166;

/**
 * Output mapping shared by bust and pendulum: `atan(v · 1.15 · π/80) / (π/80)`, a soft
 * limit that is linear (slope 1.15) near 0 and saturates at ±40.
 */
export function emoteSoftAngle(v: number): number {
  const scaled = f32(v * EMOTE_ANGLE_GAIN * EMOTE_ANGLE_UNIT);
  return f32(f32(Math.atan(scaled)) / EMOTE_ANGLE_UNIT);
}

/**
 * Gravity direction for a root rotation of `rad` radians: `DOWN` rotated by −rad.
 * Returns [gx, gy] (bust 0x10004f97, pendulum 0x1000abe1).
 */
export function emoteGravity(rad: number): [number, number] {
  const a = f32(-rad);
  const s = f32(Math.sin(a)),
    c = f32(Math.cos(a));
  return [f32(c * EMOTE_DOWN[0] - s * EMOTE_DOWN[1]), f32(s * EMOTE_DOWN[0] + c * EMOTE_DOWN[1])];
}

/**
 * `emote::EPBustControl` (vtable 0x100718c0, constructor 0x10004ed0, update 0x10004f60): a
 * damped spring. The anchor `op` follows the base layer at a fixed offset (taken at the
 * first update); the mass `p` with velocity `pv` is pulled to the anchor by `spring`, by
 * `gravity` along the rotated down vector, and damped by `friction`. The displacement
 * (anchor − mass, times the bust scale) gives `var_lr` (x, times `scale_x`) and `var_ud`
 * (−y − `ofs`, times `scale_y`) through the soft angle mapping.
 */
export class EmoteBust {
  /** +0x4 gravity, +0x8 spring, +0xc friction, +0x10 scale_x, +0x14 scale_y. */
  readonly gravity: number;
  readonly spring: number;
  readonly friction: number;
  readonly scaleX: number;
  readonly scaleY: number;
  /** +0x18. */
  first = true;
  /** +0x1c anchor, +0x28 anchor offset from the base, +0x34 mass, +0x40 velocity. */
  readonly op: Float32Array;
  readonly offset = new Float32Array(2);
  readonly p: Float32Array;
  readonly pv: Float32Array;
  /** +0x4c: y offset of the rest position. */
  ofs: number;

  private readonly initial: EmoteBustControl['param'];

  constructor(control: EmoteBustControl) {
    this.initial = control.param;
    this.gravity = f32(control.gravity);
    this.spring = f32(control.spring);
    this.friction = f32(control.friction);
    this.scaleX = f32(control.scale_x);
    this.scaleY = f32(control.scale_y);
    const v = (q: {x: number; y: number; z: number}) => Float32Array.of(q.x, q.y, q.z);
    this.op = v(control.param.op);
    this.p = v(control.param.p);
    this.pv = v(control.param.pv);
    this.ofs = f32(control.param.ofs);
  }

  /** Bust part of `Skip` (0x10013b80): back to the loaded `param` state. */
  reset(): void {
    const {op, p, pv, ofs} = this.initial;
    this.op.set([op.x, op.y, op.z]);
    this.p.set([p.x, p.y, p.z]);
    this.pv.set([pv.x, pv.y, pv.z]);
    this.ofs = f32(ofs);
    this.first = true;
  }

  /**
   * 0x10004f60: one step of `frames` with the base layer at (x, y), the player's bust
   * scale (`p+0x24`) and the root rotation in radians. Returns [var_lr, var_ud].
   */
  update(x: number, y: number, frames: number, scale: number, rad: number): [number, number] {
    const {op, p, pv} = this;
    if (this.first) {
      this.first = false;
      this.offset[0] = op[0]! - x;
      this.offset[1] = op[1]! - y;
    } else {
      op[0] = this.offset[0]! + x;
      op[1] = this.offset[1]! + y;
    }
    const [gx, gy] = emoteGravity(rad);
    const dx = f32(op[0]! - p[0]!),
      dy = f32(op[1]! - p[1]!),
      dz = f32(op[2]! - p[2]!);
    const k = f32(this.spring * frames);
    pv[0] = k * dx + pv[0]!;
    pv[1] = k * dy + pv[1]!;
    pv[2] = k * dz + pv[2]!;
    const g = f32(this.gravity * frames);
    pv[0] = g * gx + pv[0]!;
    pv[1] = g * gy + pv[1]!;
    pv[2] = g * 0 + pv[2]!;
    const fr = f32(this.friction * frames);
    pv[0] = pv[0]! - fr * pv[0]!;
    pv[1] = pv[1]! - fr * pv[1]!;
    pv[2] = pv[2]! - fr * pv[2]!;
    p[0] = pv[0]! * frames + p[0]!;
    p[1] = pv[1]! * frames + p[1]!;
    p[2] = frames * pv[2]! + p[2]!;
    const ex = f32(f32(op[0]! - p[0]!) * scale),
      ey = f32(scale * f32(op[1]! - p[1]!));
    const lr = emoteSoftAngle(f32(-ex * this.scaleX));
    const ud = emoteSoftAngle(f32((-ey - this.ofs) * this.scaleY));
    return [lr, ud];
  }
}
