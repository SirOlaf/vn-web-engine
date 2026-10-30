/**
 * Queued value tweens of the E-mote 3.9.8 player (`emotedriver.dll` x64, SHA-256
 * `80d28bd088dda8e97c7c47a9c664e55159f70505b0f9fde3158d8ce2a3e1e051`).
 *
 * `EmoteTween` (0x60 bytes: queue at +0x8, count +0x30, state +0x34, current/start/target
 * vectors +0x38/+0x40/+0x48, power +0x50, t +0x54, 1/frames +0x58) holds up to four floats.
 * The player uses it for coordinates, scale, colour, grayscale, outer forces, timeline blend
 * ratios, difference tracks, variable differences and `transitionControl` variables.
 * `EmoteRotateTween` is the single-angle variant used by `setRot` and `setOuterRot`.
 *
 * The curve is `powf(t, power)`; `easingPower` derives the exponent from an API easing value.
 */

const f32 = Math.fround;
/** `float` 1 and the end tolerance −0.0001 compared with `t − 1` (0x181fcd554, 0x181fcd5d8). */
const ONE = 1;
const END_EPSILON = f32(-0.0001);

/** Inlined at every API entry: easing value → `pow` exponent. */
export function easingPower(easing: number): number {
  const e = f32(easing);
  if (e === 0) return ONE;
  if (e > 0) return f32(e + ONE);
  return f32(ONE / f32(ONE - e));
}

/** `powf` as the CRT computes it, rounded to float. */
export function powf(x: number, y: number): number {
  return f32(Math.pow(f32(x), f32(y)));
}

interface TweenEntry {
  readonly values: Float32Array;
  readonly frames: number;
  readonly power: number;
}

export class EmoteTween {
  readonly count: number;
  private queue: TweenEntry[] = [];
  /** 0 idle, 1 running (+0x34). */
  state = 0;
  readonly current: Float32Array;
  readonly start: Float32Array;
  readonly target: Float32Array;
  power = 0;
  t = 0;
  invFrames = 0;

  /** 0x18002c1b0: all values zero. */
  constructor(count: number) {
    this.count = count;
    this.current = new Float32Array(count);
    this.start = new Float32Array(count);
    this.target = new Float32Array(count);
  }

  get queued(): number {
    return this.queue.length;
  }

  /** Running or queued. */
  get busy(): boolean {
    return this.state !== 0 || this.queue.length !== 0;
  }

  /** Values of the last queued entry, else the running target (`isAnimating` targets). */
  get lastTarget(): Float32Array {
    return this.queue[this.queue.length - 1]?.values ?? this.target;
  }

  /**
   * 0x18002c580. `frames > 0` without `queue`: replaces the running tween and the queue
   * unless the tween runs towards the same values and would end no later than `frames`
   * from now. With `queue` the entry is appended. `frames <= 0` sets the values at once.
   */
  set(values: ArrayLike<number>, frames: number, power: number, queue: boolean): void {
    const fr = f32(frames);
    if (fr > 0) {
      const entry = this.entry(values, fr, power);
      if (!queue) {
        if (
          this.state === 0 ||
          !sameValues(entry.values, this.target) ||
          fr <= f32(f32(ONE - this.t) / this.invFrames)
        ) {
          this.queue = [entry];
          this.state = 0;
        }
        return;
      }
      this.queue.push(entry);
      return;
    }
    this.queue = [];
    this.state = 0;
    for (let i = 0; i < this.count; i++) this.current[i] = values[i] ?? 0;
  }

  private entry(values: ArrayLike<number>, frames: number, power: number): TweenEntry {
    const v = new Float32Array(this.count);
    for (let i = 0; i < this.count; i++) v[i] = values[i] ?? 0;
    return {values: v, frames, power: f32(power)};
  }

  /**
   * 0x18002c6c0. Pops queued entries while idle; a running tween advances by `frames`.
   * A tween that ends in this call hands the full `frames` to the next queued entry.
   */
  step(frames: number): Float32Array {
    const dt = f32(frames);
    for (;;) {
      if (this.state === 0) {
        const entry = this.queue.shift();
        if (!entry) break;
        this.start.set(this.current);
        this.target.set(entry.values);
        this.t = 0;
        this.state = 1;
        this.invFrames = f32(ONE / entry.frames);
        this.power = entry.power;
        continue;
      }
      if (this.state !== 1) break;
      const t = f32(dt * this.invFrames + this.t);
      this.t = t;
      if (f32(t - ONE) < END_EPSILON) {
        const k = powf(t, this.power);
        for (let i = 0; i < this.count; i++) {
          const s = this.start[i]!;
          this.current[i] = f32(f32(this.target[i]! - s) * k + s);
        }
        break;
      }
      this.t = ONE;
      this.current.set(this.target);
      this.state = 0;
    }
    return this.current;
  }

  /** 0x18002c4c0: the last queued values, else the running target, become current. */
  skip(): void {
    const last = this.queue[this.queue.length - 1];
    if (!last) {
      if (this.state !== 0) {
        this.state = 0;
        this.current.set(this.target);
      }
      return;
    }
    this.state = 0;
    this.current.set(last.values);
    this.queue = [];
  }

  copyFrom(source: EmoteTween): void {
    this.queue = source.queue.map((e) => ({...e, values: e.values.slice()}));
    this.state = source.state;
    this.current.set(source.current.subarray(0, this.count));
    this.start.set(source.start.subarray(0, this.count));
    this.target.set(source.target.subarray(0, this.count));
    this.power = source.power;
    this.t = source.t;
    this.invFrames = source.invFrames;
  }
}

function sameValues(a: Float32Array, b: Float32Array): boolean {
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i]) && a[i] !== b[i]) return false;
  return true;
}

/** `float` 2π and π as the angle code compares them. */
export const EMOTE_TWO_PI = f32(2 * Math.PI);
const PI = f32(Math.PI);

/** Wraps `value` into [0, `period`), each step stored as float. */
export function wrapAngle(value: number, period: number): number {
  let x = f32(value);
  const m = f32(period);
  if (!Number.isFinite(x)) return x;
  while (x < 0) x = f32(m + x);
  while (m <= x) x = f32(x - m);
  return x;
}

interface RotateEntry {
  readonly angle: number;
  readonly frames: number;
  readonly power: number;
}

export class EmoteRotateTween {
  private queue: RotateEntry[] = [];
  state = 0;
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

  /**
   * 0x18002bdc0: the angle is wrapped to [0, 2π) first. `frames > 0` without `queue` is
   * ignored while the running tween heads for the same angle and ends sooner; otherwise the
   * queue is replaced.
   */
  set(radians: number, frames: number, power: number, queue: boolean): void {
    const a = wrapAngle(radians, EMOTE_TWO_PI);
    const fr = f32(frames);
    if (fr > 0) {
      const entry = {angle: a, frames: fr, power: f32(power)};
      if (!queue) {
        if (
          this.state !== 0 &&
          wrapAngle(this.target, EMOTE_TWO_PI) === a &&
          f32(f32(ONE - this.t) / this.invFrames) < fr
        )
          return;
        this.queue = [entry];
        this.state = 0;
        return;
      }
      this.queue.push(entry);
      return;
    }
    this.queue = [];
    this.current = a;
    this.state = 0;
  }

  /** 0x18002bb10: as `EmoteTween.step`; the target takes the shorter way round. */
  step(frames: number): number {
    const dt = f32(frames);
    for (;;) {
      if (this.state === 0) {
        const entry = this.queue.shift();
        if (!entry) break;
        const cur = this.current,
          a = entry.angle;
        this.start = cur;
        this.target = a;
        if (a <= cur) {
          if (PI < f32(cur - a)) this.target = f32(a + EMOTE_TWO_PI);
        } else if (PI < f32(a - cur)) this.target = f32(a - EMOTE_TWO_PI);
        this.t = 0;
        this.state = 1;
        this.invFrames = f32(ONE / entry.frames);
        this.power = entry.power;
        continue;
      }
      if (this.state !== 1) break;
      const t = f32(dt * this.invFrames + this.t);
      this.t = t;
      if (f32(t - ONE) < END_EPSILON) {
        const k = powf(t, this.power);
        this.current = wrapAngle(f32(f32(this.target - this.start) * k + this.start), EMOTE_TWO_PI);
        break;
      }
      this.t = ONE;
      this.current = wrapAngle(this.target, EMOTE_TWO_PI);
      this.state = 0;
    }
    return this.current;
  }

  /** 0x18002bd10. */
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
