import {f32} from './common.js';

/** Gust slots of `EPWindControl` (+0x20, 128 × 12 bytes). */
export const EMOTE_WIND_SLOTS = 128;
/** Chance per frame of a new gust (float 0.0625 at 0x10072850). */
const GUST_CHANCE = 0.0625;

/**
 * `emote::EPWindControl` (vtable 0x10071924, constructor 0x1000d630, set 0x1000d690, update
 * 0x1000d780, query 0x1000d6e0).
 *
 * Wind is a set of gusts travelling along x from `start` to `goal` (model units: the
 * `StartWind` coordinates divided by the metadata `scale`) at `velocity`. Each whole frame
 * spawns a gust with probability 1/16; its power is uniform between `powerMax` and
 * `powerMin`. A gust ends once past `goal`. A pendulum joint at x feels the first gust
 * whose window (position ± 2 · power) contains x, as an x acceleration of ±power in the
 * travel direction.
 */
export class EmoteWind {
  /** +0x4, +0x8. */
  readonly start: number;
  readonly goal: number;
  /** +0xc: set by `set`; Progress steps the wind only when it is set. */
  enabled = false;
  /** +0x10, +0x14 (`StartWind` powerMin and powerMax), +0x18 velocity, +0x1c spawn clock. */
  powerMin = 1;
  powerMax = 0;
  velocity = 0;
  clock = 0;
  readonly active = new Uint8Array(EMOTE_WIND_SLOTS);
  readonly position = new Float32Array(EMOTE_WIND_SLOTS);
  readonly power = new Float32Array(EMOTE_WIND_SLOTS);

  constructor(start: number, goal: number) {
    this.start = f32(start);
    this.goal = f32(goal);
  }

  /** 0x1000d690. */
  set(powerMin: number, powerMax: number, speed: number): void {
    this.powerMin = f32(powerMin);
    this.powerMax = f32(powerMax);
    const sign = f32(this.goal - this.start) >= 0 ? 1 : -1;
    this.enabled = true;
    this.velocity = f32(sign * speed);
    this.clock = 0;
  }

  /** 0x1000d780: one sub-step of `frames`. `random` is the shared generator (0x100875ec). */
  update(frames: number, random: () => number): void {
    this.clock = f32(frames + this.clock);
    if (this.clock >= 0) {
      do {
        this.clock = f32(this.clock - 1);
        if (f32(random()) < GUST_CHANCE) {
          const i = this.active.indexOf(0);
          if (i !== -1) {
            this.active[i] = 1;
            this.position[i] = this.start;
            const r = random();
            this.power[i] = f32(r * (this.powerMin - this.powerMax) + this.powerMax);
          }
        }
      } while (this.clock >= 0);
    }
    for (let i = 0; i < EMOTE_WIND_SLOTS; i++) {
      if (!this.active[i]) continue;
      const x = f32(frames * this.velocity + this.position[i]!);
      this.position[i] = x;
      if (this.velocity > 0 && this.goal < x) this.active[i] = 0;
      if (this.velocity < 0 && this.goal > x) this.active[i] = 0;
    }
  }

  /** 0x1000d6e0: acceleration at x. */
  query(x: number): number {
    for (let i = 0; i < EMOTE_WIND_SLOTS; i++) {
      if (!this.active[i]) continue;
      const half = f32(this.power[i]! * 0.5 * 4);
      const p = this.position[i]!;
      if (p - half < x && x < half + p) return f32(this.power[i]! * (this.velocity < 0 ? -1 : 1));
    }
    return 0;
  }
}
