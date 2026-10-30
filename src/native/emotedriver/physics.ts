/**
 * Physics controls of the E-mote 3.9.8 player (`emotedriver.dll` x64, SHA-256
 * `80d28bd088dda8e97c7c47a9c664e55159f70505b0f9fde3158d8ce2a3e1e051`): the bust spring
 * (`EPBustControl`), the two-segment pendulum used by `hairControl` and `partsControl`
 * (`EPPendControl`) and the wind field (`EPWindControl`).
 *
 * Each control follows a base layer position, steps in sub-steps of at most 1.1 frames and
 * writes its outputs (`var_lr`, `var_ud`, and for pendulums `var_lrm`) into the player's
 * variable values after Progress applied the other variables to the clip.
 */

import type {
  EmoteBustControl,
  EmotePendulumControl,
  EmoteVec3,
} from '../../formats/emote/metadata.js';
import {EmoteRandom, fmodf} from './controls.js';

const f32 = Math.fround;
/** Sub-step limit 1.1 (0x181fcd558), `FLT_EPSILON` (0x181fcd510). */
const SUB_STEP = f32(1.1);
const FLT_EPSILON = f32(2 ** -23);
/** Outputs at or below 0.01 in magnitude are written as 0 (0x181fcd520). */
const OUTPUT_EPSILON = f32(0.01);
/** `atanf(x · 1.15 · π/80) / (π/80)` shapes every output (0x181fcd55c, 0x181fcd52c). */
const OUTPUT_GAIN = f32(1.15);
const OUTPUT_UNIT = f32(0.03926991);
/** Pendulum bend amplitude rate 1/32 (0x181fcd528) and threshold 28 (0x181fcd5a4). */
const BEND_RATE = f32(0.03125);
const BEND_THRESHOLD = f32(28);
const TWO_PI = f32(6.283185);
/** Pendulum minimum length for the constraint (0x181fcd524). */
const MIN_DISTANCE = f32(0.015625);
/** Wind spawn chance per frame (0x181fcd534), slot count, spawn width factor. */
const WIND_CHANCE = f32(0.0625);
const WIND_SLOTS = 0x80;
/** Gravity (0, 1, 0) and wind direction (1, 0, 0): `.data` 0x181fdda34…0x181fdda44. */
const GX = 0,
  GY = 1;

/** The player state the controls read. */
export interface EmotePhysicsHost {
  /**
   * 0x18000e6d0: the base layer's world position after outer rotation and scale handling,
   * or null when the layer is missing or not a plain layer.
   */
  basePosition(layer: string): readonly [number, number] | null;
  /** Clip rotation plus outer rotation in radians (0x180018cb0 + outer tween). */
  readonly physicsAngle: number;
  /** `bustScale`, `hairScale`, `partsScale`. */
  readonly bustScale: number;
  readonly hairScale: number;
  readonly partsScale: number;
  readonly wind: EmoteWind | null;
  setValue(label: string, value: number): void;
}

function atanOutput(x: number): number {
  return f32(f32(Math.atan(f32(x))) / OUTPUT_UNIT);
}

class BustSpring {
  /** +0x1c: the next step re-anchors the target offset. */
  reset = true;
  /** +0x20 target, +0x2c offset, +0x38 position, +0x44 velocity, +0x50 vertical offset. */
  tx = 0;
  ty = 0;
  tz = 0;
  ox = 0;
  oy = 0;
  px = 0;
  py = 0;
  pz = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  ofs = 0;

  constructor(
    private readonly gravity: number,
    private readonly spring: number,
    private readonly friction: number,
    private readonly scaleX: number,
    private readonly scaleY: number,
  ) {}

  /** 0x180027be0. */
  step(x: number, y: number, dt: number, scale: number, angle: number): [number, number] {
    let ax: number, ay: number;
    if (!this.reset) {
      ax = f32(x + this.ox);
      ay = f32(y + this.oy);
      this.tx = ax;
      this.ty = ay;
    } else {
      ax = this.tx;
      ay = this.ty;
      this.reset = false;
      this.ox = f32(ax - x);
      this.oy = f32(ay - y);
    }
    const a = f32(-angle);
    const s = f32(Math.sin(a)),
      c = f32(Math.cos(a));
    const gyc = f32(c * GY),
      gxc = f32(c * GX),
      gys = f32(s * GY),
      gxs = f32(s * GX);
    const kg = f32(dt * this.gravity),
      ks = f32(dt * this.spring),
      kf = f32(dt * this.friction);
    let vx = f32(f32(f32(ax - this.px) * ks) + this.vx);
    this.vx = vx;
    vx = f32(f32(f32(gxc - gys) * kg) + vx);
    let vz = f32(f32(f32(f32(this.tz - this.pz) * ks) + this.vz) + f32(kg * 0));
    let vy = f32(f32(f32(f32(ay - this.py) * ks) + this.vy) + f32(f32(gyc + gxs) * kg));
    vx = f32(vx - f32(vx * kf));
    vy = f32(vy - f32(vy * kf));
    vz = f32(vz - f32(vz * kf));
    this.vx = vx;
    this.vy = vy;
    this.vz = vz;
    this.px = f32(f32(vx * dt) + this.px);
    this.py = f32(f32(vy * dt) + this.py);
    this.pz = f32(f32(vz * dt) + this.pz);
    const lr = atanOutput(
      f32(
        f32(f32(f32(-f32(f32(this.tx - this.px) * scale)) * this.scaleX) * OUTPUT_GAIN) *
          OUTPUT_UNIT,
      ),
    );
    const ud = atanOutput(
      f32(
        f32(
          f32(f32(f32(-f32(f32(this.ty - this.py) * scale)) - this.ofs) * this.scaleY) *
            OUTPUT_GAIN,
        ) * OUTPUT_UNIT,
      ),
    );
    return [lr, ud];
  }
}

/** `bustControl` entry (+0xf0, 0xa0 bytes; loader 0x180011690, step 0x180012580). */
export class EmoteBust {
  private readonly spring: BustSpring;
  /** +0x8: the next step is the first after a reset. */
  private first = true;
  private prevX = 0;
  private prevY = 0;

  constructor(readonly control: EmoteBustControl) {
    this.spring = new BustSpring(
      f32(control.gravity),
      f32(control.spring),
      f32(control.friction),
      f32(control.scale_x),
      f32(control.scale_y),
    );
    this.load();
  }

  private load(): void {
    const {op, p, pv, ofs} = this.control.param;
    const s = this.spring;
    s.tx = f32(op.x);
    s.ty = f32(op.y);
    s.tz = f32(op.z);
    s.px = f32(p.x);
    s.py = f32(p.y);
    s.pz = f32(p.z);
    s.vx = f32(pv.x);
    s.vy = f32(pv.y);
    s.vz = f32(pv.z);
    s.ofs = f32(ofs);
  }

  /** 0x180012490 (one entry): restores the loaded state and zeroes the outputs. */
  reset(host: EmotePhysicsHost): void {
    this.load();
    this.spring.reset = true;
    this.first = true;
    host.setValue(this.control.var_lr, 0);
    host.setValue(this.control.var_ud, 0);
  }

  /** 0x180012580 (one entry); `force` is the accumulated outer force. */
  step(host: EmotePhysicsHost, dt: number, fx: number, fy: number): void {
    const base = host.basePosition(this.control.baseLayer) ?? [0, 0];
    const x = f32(base[0] + fx),
      y = f32(base[1] + fy);
    let out: [number, number] = [0, 0];
    if (!this.first) {
      let t = 0;
      const end = f32(dt - FLT_EPSILON);
      if (end > 0) {
        do {
          const h = f32(dt - t) <= SUB_STEP ? f32(dt - t) : SUB_STEP;
          t = f32(t + h);
          const r = f32(t / dt);
          out = this.spring.step(
            f32(f32(f32(1 - r) * this.prevX) + f32(r * x)),
            f32(f32(f32(1 - r) * this.prevY) + f32(r * y)),
            h,
            f32(host.bustScale),
            f32(host.physicsAngle),
          );
        } while (t < end);
      }
    } else {
      this.first = false;
      out = this.spring.step(x, y, 0, f32(host.bustScale), f32(host.physicsAngle));
    }
    this.prevX = x;
    this.prevY = y;
    let [lr, ud] = out;
    if (Math.abs(lr) <= OUTPUT_EPSILON && Math.abs(ud) <= OUTPUT_EPSILON) lr = ud = 0;
    host.setValue(this.control.var_lr, lr);
    host.setValue(this.control.var_ud, ud);
  }
}

class Vec {
  constructor(
    public x = 0,
    public y = 0,
    public z = 0,
  ) {}
  set(v: EmoteVec3): void {
    this.x = f32(v.x);
    this.y = f32(v.y);
    this.z = f32(v.z);
  }
}

/** `EPPendControl` (0xb8 bytes, constructor 0x180012e30, step 0x18002b380). */
class Pendulum {
  /** +0x40. */
  reset = true;
  /** +0x44 base (anchor), +0x50 anchor offset. */
  readonly base = new Vec();
  ox = 0;
  oy = 0;
  /** +0x5c/+0x68 rest joints, +0x74/+0x80 masses, +0x8c/+0x98 velocities. */
  readonly rest = [new Vec(), new Vec()] as const;
  readonly mass = [new Vec(), new Vec()] as const;
  readonly vel = [new Vec(), new Vec()] as const;
  /** +0xa4 vertical offset, +0xa8 bend phase, +0xac bend amplitude. */
  ofs = 0;
  bendPhase = 0;
  bendAmp = 0;
  wind: EmoteWind | null = null;

  constructor(readonly c: EmotePendulumControl) {}

  /** Returns [lr, lrm, ud]. */
  step(x: number, y: number, dt: number, scale: number, angle: number): [number, number, number] {
    const c = this.c;
    if (!this.reset) {
      this.base.x = f32(x + this.ox);
      this.base.y = f32(y + this.oy);
    } else {
      this.reset = false;
      this.ox = f32(this.base.x - x);
      this.oy = f32(this.base.y - y);
    }
    const len = [f32(c.length[0]), f32(c.length[1])];
    // Rest joints hang along gravity from the anchor.
    this.rest[0].x = f32(f32(len[0]! * GX) + this.base.x);
    this.rest[0].y = f32(f32(len[0]! * GY) + this.base.y);
    this.rest[0].z = f32(f32(len[0]! * 0) + this.base.z);
    this.rest[1].x = f32(f32(len[1]! * GX) + this.rest[0].x);
    this.rest[1].y = f32(f32(len[1]! * GY) + this.rest[0].y);
    this.rest[1].z = f32(f32(len[1]! * 0) + this.rest[0].z);
    const a = f32(-angle);
    const sn = f32(Math.sin(a)),
      cs = f32(Math.cos(a));
    const sx = f32(sn * GX),
      cx = f32(cs * GX),
      sy = f32(sn * GY),
      cy = f32(cs * GY);
    const out: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < 2; i++) {
      const anchor = i === 0 ? this.base : this.mass[0];
      const m = this.mass[i]!,
        v = this.vel[i]!;
      const l = len[i]!;
      const dx = f32(anchor.x - m.x),
        dy = f32(anchor.y - m.y),
        dz = f32(anchor.z - m.z);
      let d2 = f32(f32(f32(dy * dy) + f32(dx * dx)) + f32(dz * dz));
      if (f32(l * l) < d2) {
        const d = f32(Math.sqrt(d2));
        if (MIN_DISTANCE < d) {
          const inv = f32(1 / d);
          const ext = f32(d - l);
          const nx = f32(inv * dx),
            nz = f32(inv * dz),
            ny = f32(inv * dy);
          if (i === 1) {
            m.x = f32(f32(nx * ext) + m.x);
            m.z = f32(f32(nz * ext) + m.z);
            m.y = f32(f32(ny * ext) + m.y);
            const k = f32(
              f32(f32(f32(f32(nx * v.x) + f32(ny * v.y)) + f32(nz * v.z)) * f32(-f32(c.v_bound))) *
                dt,
            );
            v.x = f32(f32(nx * k) + v.x);
            v.y = f32(f32(k * ny) + v.y);
            v.z = f32(f32(k * nz) + v.z);
          } else {
            const k = f32(f32(ext * f32(c.b_rate)) * dt);
            v.x = f32(f32(nx * k) + v.x);
            v.y = f32(f32(k * ny) + v.y);
            v.z = f32(f32(k * nz) + v.z);
          }
        }
      }
      d2 = 0;
      const kg = f32(dt * f32(c.gravity));
      let vx = f32(f32(f32(cx - sy) * kg) + v.x);
      let vy = f32(f32(f32(cy + sx) * kg) + v.y);
      let vz = f32(f32(kg * 0) + v.z);
      if (this.wind) {
        const w = this.wind.forceAt(m.x);
        vx = f32(f32(w * 1) + vx);
        vy = f32(f32(w * 0) + vy);
        vz = f32(f32(w * -0) + vz);
      }
      vx = f32(vx - f32(f32(vx * f32(c.friction_x)) * dt));
      m.x = f32(f32(vx * dt) + m.x);
      vy = f32(vy - f32(f32(vy * f32(c.friction_y)) * dt));
      m.y = f32(f32(vy * dt) + m.y);
      m.z = f32(f32(vz * dt) + m.z);
      v.x = vx;
      v.y = vy;
      v.z = vz;
      const r = this.rest[i]!;
      const lr = atanOutput(
        f32(
          f32(f32(f32(f32(-f32(r.x - m.x)) * f32(c.scale_x[i]!)) * scale) * OUTPUT_GAIN) *
            OUTPUT_UNIT,
        ),
      );
      out[i] = lr;
      if (i === Math.trunc(c.ud_eft)) {
        out[2] = atanOutput(
          f32(
            f32(
              f32(f32(f32(this.ofs - f32(r.y - m.y)) * f32(c.scale_y[i]!)) * scale) * OUTPUT_GAIN,
            ) * OUTPUT_UNIT,
          ),
        );
      }
    }
    return out;
  }
}

/** `hairControl`/`partsControl` entry (0x108 bytes; loader 0x180013380, step 0x180014180). */
export class EmotePendulum {
  private readonly pend: Pendulum;
  private first = true;
  private prevX = 0;
  private prevY = 0;

  constructor(readonly control: EmotePendulumControl) {
    this.pend = new Pendulum(control);
    this.load();
  }

  private load(): void {
    const q = this.control.param,
      p = this.pend;
    p.base.set(q.op);
    p.rest[0].set(q.bp[0]);
    p.rest[1].set(q.bp[1]);
    p.mass[0].set(q.p[0]);
    p.mass[1].set(q.p[1]);
    p.vel[0].set(q.pv[0]);
    p.vel[1].set(q.pv[1]);
    p.ofs = f32(q.ofs);
    p.bendPhase = f32(q.bendR);
    p.bendAmp = f32(q.bendS);
  }

  /** 0x180014020 (one entry). */
  reset(host: EmotePhysicsHost): void {
    this.load();
    this.pend.reset = true;
    host.setValue(this.control.var_lr, 0);
    host.setValue(this.control.var_lrm, 0);
    host.setValue(this.control.var_ud, 0);
    this.first = true;
  }

  private bend(h: number, lr: number, lrm: number, ud: number): [number, number] {
    const p = this.pend;
    let amp: number;
    if (Math.abs(ud) <= BEND_THRESHOLD) {
      const v = f32(p.bendAmp - f32(h * BEND_RATE));
      amp = 0 <= v ? v : 0;
    } else {
      const v = f32(f32(h * BEND_RATE) + p.bendAmp);
      amp = v <= 1 ? v : 1;
    }
    p.bendAmp = amp;
    p.bendPhase = fmodf(f32(f32(f32(amp * f32(this.control.bend_spd)) * h) + p.bendPhase), TWO_PI);
    const d = f32(f32(f32(Math.sin(p.bendPhase)) * amp) * f32(this.control.bend_vol));
    return [f32(lr - d), f32(lrm + d)];
  }

  /** 0x180014180 (one entry). */
  step(host: EmotePhysicsHost, dt: number, scale: number, fx: number, fy: number): void {
    const base = host.basePosition(this.control.baseLayer) ?? [0, 0];
    const x = f32(base[0] + fx),
      y = f32(base[1] + fy);
    this.pend.wind = host.wind;
    let lr = 0,
      lrm = 0,
      ud = 0;
    if (!this.first) {
      let t = 0;
      const end = f32(dt - FLT_EPSILON);
      if (end > 0) {
        do {
          const h = f32(dt - t) <= SUB_STEP ? f32(dt - t) : SUB_STEP;
          t = f32(t + h);
          const r = f32(t / dt);
          [lr, lrm, ud] = this.pend.step(
            f32(f32(f32(1 - r) * this.prevX) + f32(r * x)),
            f32(f32(f32(1 - r) * this.prevY) + f32(r * y)),
            h,
            f32(scale),
            f32(host.physicsAngle),
          );
          [lr, lrm] = this.bend(h, lr, lrm, ud);
        } while (t < end);
      }
    } else {
      this.first = false;
      [lr, lrm, ud] = this.pend.step(x, y, 0, f32(scale), f32(host.physicsAngle));
      [lr, lrm] = this.bend(0, lr, lrm, ud);
    }
    this.prevX = x;
    this.prevY = y;
    if (
      Math.abs(lrm) <= OUTPUT_EPSILON &&
      Math.abs(lr) <= OUTPUT_EPSILON &&
      Math.abs(ud) <= OUTPUT_EPSILON
    )
      lr = lrm = ud = 0;
    host.setValue(this.control.var_lr, lrm);
    host.setValue(this.control.var_lrm, lr);
    host.setValue(this.control.var_ud, ud);
  }
}

/**
 * `EPWindControl` (0x618 bytes, constructor 0x18002cc40, step 0x18002cfa0, `startWind`
 * 0x18001ac70): gusts of random width travel from `start` to `end` at `speed`.
 */
export class EmoteWind {
  readonly start: number;
  readonly end: number;
  /** +0x14, +0x18: width range. */
  maxWidth = 1;
  minWidth = 0;
  /** +0x1c: signed speed. */
  speed = 0;
  /** +0x10. */
  enabled = false;
  private timer = 0;
  private readonly active = new Uint8Array(WIND_SLOTS);
  private readonly position = new Float32Array(WIND_SLOTS);
  private readonly width = new Float32Array(WIND_SLOTS);

  constructor(
    start: number,
    end: number,
    private readonly random: EmoteRandom,
  ) {
    this.start = f32(start);
    this.end = f32(end);
  }

  /** The `startWind` tail: enables the field with a new signed speed. */
  restart(speed: number): void {
    this.enabled = true;
    this.timer = 0;
    this.speed = f32(speed);
  }

  step(dt: number): void {
    let timer = f32(f32(dt) + this.timer);
    this.timer = timer;
    for (;;) {
      if (timer < 0) {
        for (let i = 0; i < WIND_SLOTS; i++) {
          if (!this.active[i]) continue;
          const p = f32(f32(f32(dt) * this.speed) + this.position[i]!);
          this.position[i] = p;
          if (0 < this.speed && this.end <= p && p !== this.end) this.active[i] = 0;
          if (this.speed < 0 && p < this.end) this.active[i] = 0;
        }
        return;
      }
      this.timer = f32(timer - 1);
      if (this.random.next() < WIND_CHANCE) {
        const i = this.active.indexOf(0);
        if (i >= 0) {
          this.active[i] = 1;
          this.position[i] = this.start;
          this.width[i] = f32(
            f32(this.random.next() * f32(this.maxWidth - this.minWidth)) + this.minWidth,
          );
        }
      }
      timer = this.timer;
    }
  }

  /** The horizontal force on a mass at `x` (0x18002b380 wind part). */
  forceAt(x: number): number {
    for (let i = 0; i < WIND_SLOTS; i++) {
      if (!this.active[i]) continue;
      const w = this.width[i]!;
      const half = f32(f32(w * 0.5) * 4);
      const c = this.position[i]!;
      if (f32(c - half) < x && x < f32(c + half)) return this.speed < 0 ? f32(-1 * w) : f32(1 * w);
    }
    return 0;
  }
}
