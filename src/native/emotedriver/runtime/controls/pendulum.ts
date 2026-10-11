import type {EmotePendulumControl} from '../../../../formats/kirikiri/emote-metadata.js';
import {EMOTE_DOWN, EMOTE_WIND_AXIS, emoteGravity, emoteSoftAngle} from './bust.js';
import {f32} from './common.js';
import type {EmoteWind} from './wind.js';

/** |var_ud| above which the bend oscillation builds up (double 28.0 at 0x10072818). */
const BEND_THRESHOLD = 28;
/** Bend ramp per frame (double 0x10072810). */
const BEND_RAMP = 0.03125;
/** Rod constraints are skipped below this length (float 0x10072820). */
const MIN_ROD = f32(0.015625);
/** 2π as stored (double 0x10072760). */
const TWO_PI = 6.2831854820251465;

/** Outputs of one pendulum step. */
export interface EmotePendulumOutput {
  /** Segment 1 displacement (`var_lr`). */
  lr: number;
  /** Segment 0 displacement (`var_lrm`). */
  lrm: number;
  /** Vertical displacement of segment `ud_eft` (`var_ud`). */
  ud: number;
}

/**
 * `emote::EPPendControl` (vtable 0x10071904, constructor 0x1000a8d0, parameters 0x1000aa70,
 * update 0x1000ab30, bend 0x1000b050): a two-joint chain for hair and parts.
 *
 * The anchor `op` follows the base layer at a fixed offset. Each update recomputes the rest
 * points `bp[0] = op + DOWN · length[0]` and `bp[1] = bp[0] + DOWN · length[1]`. Per joint i:
 *
 * - when the joint is further than `length[i]` from its parent (anchor, then joint 0),
 *   joint 0 is accelerated towards it by excess · `b_rate` (a spring), while joint 1 is
 *   moved back onto the rod and loses `v_bound` of its velocity along the rod;
 * - gravity along the rotated down vector, the wind gust at the joint's x, and friction
 *   (`friction_x`, `friction_y`, per axis) act on the velocity; the joint moves.
 *
 * Outputs are rest − position, through the soft angle mapping: joint 0 x · `scale_x[0]`
 * gives `var_lrm`, joint 1 x · `scale_x[1]` gives `var_lr`, and joint `ud_eft` gives
 * (`ofs` − y) · `scale_y[ud_eft]` as `var_ud`. All three are multiplied by the player's
 * hair or parts scale. The bend (0x1000b050) then adds a sine sway of amplitude
 * `bend_vol` · bendS and angular speed `bend_spd` · bendS to `var_lr` and subtracts it from
 * `var_lrm`; bendS ramps to 1 while |var_ud| > 28 and back to 0 otherwise, bendR is the
 * phase.
 */
export class EmotePendulum {
  /** +0x4 gravity, +0x8 friction_x, +0xc friction_y, +0x10 b_rate, +0x14 v_bound. */
  readonly gravity: number;
  readonly frictionX: number;
  readonly frictionY: number;
  readonly bRate: number;
  readonly vBound: number;
  /** +0x18: index of the joint that drives `var_ud`. */
  readonly udEffect: number;
  /** +0x1c length[2], +0x24 scale_x[2], +0x2c scale_y[2], +0x34 bend_spd, +0x38 bend_vol. */
  readonly length: readonly [number, number];
  readonly scaleX: readonly [number, number];
  readonly scaleY: readonly [number, number];
  readonly bendSpeed: number;
  readonly bendVolume: number;
  /** +0x3c. */
  first = true;
  /** +0x40 anchor, +0x4c anchor offset, +0x58 rest points, +0x70 joints, +0x88 velocities. */
  readonly op: Float32Array;
  readonly offset = new Float32Array(2);
  readonly bp: [Float32Array, Float32Array];
  readonly p: [Float32Array, Float32Array];
  readonly pv: [Float32Array, Float32Array];
  /** +0xa0 ofs, +0xa4 bendR (phase), +0xa8 bendS (strength). */
  ofs: number;
  bendR: number;
  bendS: number;

  private readonly initial: EmotePendulumControl['param'];

  constructor(control: EmotePendulumControl) {
    this.initial = control.param;
    this.gravity = f32(control.gravity);
    this.frictionX = f32(control.friction_x);
    this.frictionY = f32(control.friction_y);
    this.bRate = f32(control.b_rate);
    this.vBound = f32(control.v_bound);
    this.udEffect = control.ud_eft;
    this.length = [f32(control.length[0]), f32(control.length[1])];
    this.scaleX = [f32(control.scale_x[0]), f32(control.scale_x[1])];
    this.scaleY = [f32(control.scale_y[0]), f32(control.scale_y[1])];
    this.bendSpeed = f32(control.bend_spd);
    this.bendVolume = f32(control.bend_vol);
    const v = (q: {x: number; y: number; z: number}) => Float32Array.of(q.x, q.y, q.z);
    const {param} = control;
    this.op = v(param.op);
    this.bp = [v(param.bp[0]), v(param.bp[1])];
    this.p = [v(param.p[0]), v(param.p[1])];
    this.pv = [v(param.pv[0]), v(param.pv[1])];
    this.ofs = f32(param.ofs);
    this.bendR = f32(param.bendR);
    this.bendS = f32(param.bendS);
  }

  /** Pendulum part of `Skip` (0x10015480 → 0x1000aa70): back to the loaded `param` state. */
  reset(): void {
    const q = this.initial;
    const v3 = (a: Float32Array, b: {x: number; y: number; z: number}) => a.set([b.x, b.y, b.z]);
    v3(this.op, q.op);
    for (let i = 0; i < 2; i++) {
      v3(this.bp[i]!, q.bp[i]!);
      v3(this.p[i]!, q.p[i]!);
      v3(this.pv[i]!, q.pv[i]!);
    }
    this.ofs = f32(q.ofs);
    this.bendR = f32(q.bendR);
    this.bendS = f32(q.bendS);
    this.first = true;
  }

  /**
   * 0x1000ab30 then 0x1000b050: one step of `frames` with the base layer at (x, y), the
   * hair or parts scale, the root rotation in radians and the player's wind (`+0xac`, set
   * from `p+0x138` before each driver call). `out` keeps values a step does not write
   * (`var_ud` when `ud_eft` is neither 0 nor 1).
   */
  update(
    x: number,
    y: number,
    frames: number,
    scale: number,
    rad: number,
    wind: EmoteWind | null,
    out: EmotePendulumOutput,
  ): void {
    const {op} = this;
    if (this.first) {
      this.first = false;
      this.offset[0] = op[0]! - x;
      this.offset[1] = op[1]! - y;
    } else {
      op[0] = this.offset[0]! + x;
      op[1] = this.offset[1]! + y;
    }
    for (let i = 0; i < 3; i++) this.bp[0][i] = EMOTE_DOWN[i]! * this.length[0] + op[i]!;
    for (let i = 0; i < 3; i++) this.bp[1][i] = EMOTE_DOWN[i]! * this.length[1] + this.bp[0][i]!;
    const [gx, gy] = emoteGravity(rad);
    for (let i = 0; i < 2; i++) {
      const L = this.length[i]!;
      const parent = i === 0 ? op : this.p[0];
      const p = this.p[i]!,
        pv = this.pv[i]!,
        bp = this.bp[i]!;
      const dx = f32(parent[0]! - p[0]!),
        dy = f32(parent[1]! - p[1]!),
        dz = f32(parent[2]! - p[2]!);
      const d2 = f32(dx * dx + dy * dy + dz * dz);
      if (d2 > L * L) {
        const dist = f32(Math.sqrt(d2));
        if (dist > MIN_ROD) {
          const inverse = f32(1 / dist);
          const nx = f32(inverse * dx),
            ny = f32(inverse * dy),
            nz = f32(inverse * dz);
          if (i === 0) {
            const k = f32((dist - L) * this.bRate * frames);
            pv[0] = k * nx + pv[0]!;
            pv[1] = k * ny + pv[1]!;
            pv[2] = k * nz + pv[2]!;
          } else {
            const excess = f32(dist - L);
            p[0] = excess * nx + p[0]!;
            p[1] = excess * ny + p[1]!;
            p[2] = excess * nz + p[2]!;
            const along = f32(pv[1]! * ny + pv[0]! * nx + pv[2]! * nz);
            const j = f32(-this.vBound * along * frames);
            pv[0] = j * nx + pv[0]!;
            pv[1] = j * ny + pv[1]!;
            pv[2] = j * nz + pv[2]!;
          }
        }
      }
      const g = f32(frames * this.gravity);
      pv[0] = g * gx + pv[0]!;
      pv[1] = g * gy + pv[1]!;
      pv[2] = g * 0 + pv[2]!;
      if (wind) {
        const w = wind.query(p[0]!);
        pv[0] = w * EMOTE_WIND_AXIS[0] + pv[0]!;
        pv[1] = w * EMOTE_WIND_AXIS[1] + pv[1]!;
        pv[2] = w * EMOTE_WIND_AXIS[2] + pv[2]!;
      }
      pv[0] = pv[0]! - this.frictionX * pv[0]! * frames;
      pv[1] = pv[1]! - this.frictionY * pv[1]! * frames;
      p[0] = pv[0]! * frames + p[0]!;
      p[1] = pv[1]! * frames + p[1]!;
      p[2] = frames * pv[2]! + p[2]!;
      const ex = f32(bp[0]! - p[0]!),
        ey = f32(bp[1]! - p[1]!);
      const horizontal = emoteSoftAngle(f32(-ex * this.scaleX[i]! * scale));
      if (i === 0) out.lrm = horizontal;
      else out.lr = horizontal;
      if (i === this.udEffect)
        out.ud = emoteSoftAngle(f32((this.ofs - ey) * this.scaleY[i]! * scale));
    }
    this.bend(frames, out);
  }

  /** 0x1000b050. */
  private bend(frames: number, out: EmotePendulumOutput): void {
    if (Math.abs(out.ud) > BEND_THRESHOLD) {
      const s = f32(frames * BEND_RAMP + this.bendS);
      this.bendS = 1 < s ? 1 : s;
    } else {
      const s = f32(this.bendS - BEND_RAMP * frames);
      this.bendS = 0 > s ? 0 : s;
    }
    const phase = f32(this.bendS * this.bendSpeed * frames + this.bendR);
    this.bendR = f32(phase % TWO_PI);
    const sway = f32(f32(Math.sin(this.bendR)) * this.bendS * this.bendVolume);
    out.lr = f32(out.lr + sway);
    out.lrm = f32(out.lrm - sway);
  }
}
