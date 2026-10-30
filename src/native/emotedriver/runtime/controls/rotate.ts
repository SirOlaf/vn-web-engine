/**
 * `emote::EPRotateControl` (vtable 0x1007190c, 0x38 bytes, player `p+0x148`): the queued
 * `SetRot` tween. Angles are radians in [0, 2π) and the tween takes the shorter way round.
 *
 * Addresses refer to `emotedriver.dll` SHA-256 `a3b693b6…5e70b3a86`. The curve is
 * `pow(t, power)` as in `EmoteTween` (`./transition.ts`).
 */

const f32 = Math.fround;

/** `float` 2π (0x10072808) and π as the comparisons in 0x1000b380 use them. */
export const EMOTE_TWO_PI = f32(2 * Math.PI);
const PI = f32(Math.PI);

/** 0x1000b150: wraps `value` into [0, `period`). Each step is stored as `float`. */
export function wrapAngle(value: number, period: number): number {
  let x = f32(value);
  const m = f32(period);
  while (x < 0) x = f32(m + x);
  if (x >= m) {
    do x = f32(x - m);
    while (m <= x);
  }
  return x;
}

interface RotateEntry {
  readonly angle: number;
  readonly frames: number;
  readonly power: number;
}

export class EmoteRotateTween {
  /** Deque at +0x4 (entry 0xc bytes: angle, frames, power; pushed by 0x10005c80). */
  private queue: RotateEntry[] = [];
  /** 0 idle, 1 running (+0x1c). */
  state = 0;
  /** Current (+0x20), start (+0x24), target (+0x28), power (+0x2c), t (+0x30), 1/frames (+0x34). */
  current = 0;
  start = 0;
  target = 0;
  power = 0;
  t = 0;
  invFrames = 0;

  get queued(): number {
    return this.queue.length;
  }

  get busy(): boolean {
    return this.state !== 0 || this.queue.length !== 0;
  }

  /** 0x1000b2d0: as `EmoteTween.set` for one angle, wrapped to [0, 2π) first. */
  set(radians: number, frames: number, power: number, queue: boolean): void {
    const a = wrapAngle(radians, EMOTE_TWO_PI);
    const fr = f32(frames);
    if (fr > 0) {
      if (!queue) {
        this.queue = [];
        this.state = 0;
      }
      this.queue.push({angle: a, frames: fr, power: f32(power)});
      return;
    }
    this.queue = [];
    this.current = a;
    this.state = 0;
  }

  /** 0x1000b380: returns the current angle (radians). */
  step(frames: number): number {
    if (this.state === 0) {
      const entry = this.queue.shift();
      if (entry) {
        const cur = this.current;
        const a = entry.angle;
        this.start = cur;
        this.target = a;
        if (a <= cur) {
          if (PI < cur - a) this.target = f32(a + EMOTE_TWO_PI);
        } else if (PI < a - cur) {
          this.target = f32(a - EMOTE_TWO_PI);
        }
        this.state++;
        this.invFrames = f32(1 / entry.frames);
        this.power = entry.power;
        this.t = 0;
      }
    } else if (this.state === 1) {
      const t = f32(this.invFrames * f32(frames) + this.t);
      this.t = t;
      if (t < 1 || Number.isNaN(t)) {
        const k = f32(Math.pow(t, this.power));
        this.current = wrapAngle(f32((this.target - this.start) * k + this.start), EMOTE_TWO_PI);
      } else {
        this.t = 1;
        this.current = wrapAngle(this.target, EMOTE_TWO_PI);
        this.state = 0;
      }
    }
    return this.current;
  }

  /** 0x1000b240: finishes at once (last queued angle, else the running target). */
  skip(): void {
    const last = this.queue[this.queue.length - 1];
    if (!last) {
      if (this.state !== 0) {
        this.state = 0;
        this.current = wrapAngle(this.target, EMOTE_TWO_PI);
      }
      return;
    }
    this.state = 0;
    this.current = last.angle;
    this.queue = [];
  }

  /** `AssignState` (0x1000f2a0) copies +0x1c..+0x34 and the queue. */
  copyFrom(source: EmoteRotateTween): void {
    this.queue = source.queue.slice();
    this.state = source.state;
    this.current = source.current;
    this.start = source.start;
    this.target = source.target;
    this.power = source.power;
    this.t = source.t;
    this.invFrames = source.invFrames;
  }
}
