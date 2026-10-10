/**
 * `emote::EPTransitionControl` (vtable 0x1007191c, 0x3c bytes): a queued tween of a fixed
 * number of float values. The player uses it for `SetCoord` (2 values, `p+0x13c`), `SetScale`
 * (1, `p+0x140`), `SetColor` (4, `p+0x144`), timeline blend ratios and difference tracks (1),
 * and `transitionControl` variables (1, `p+0xe4`).
 *
 * Addresses refer to `emotedriver.dll` SHA-256 `a3b693b6…5e70b3a86`.
 *
 * The easing curve is `pow(t, power)` (CRT `_CIpow` 0x100680b0 in 0x1000c300), with the power
 * derived from the caller's easing value by `easingPower` (0x10012310). It is unrelated to the
 * keyframe easing curve 0x1002a590.
 */

const f32 = Math.fround;

/** 0x10012310 (inlined in 0x10012510, 0x1001b3a0 …): easing value → `pow` exponent. */
export function easingPower(easing: number): number {
  const e = f32(easing);
  if (e === 0) return 1;
  if (e > 0) return f32(e + 1);
  return f32(1 / (1 - e));
}

/** Queue entry (0x18 bytes, pushed by 0x1000bb50/0x1000d140): targets, frames, power. */
interface TweenEntry {
  readonly values: Float32Array;
  readonly frames: number;
  readonly power: number;
}

export class EmoteTween {
  /** Value count (+0x1c). */
  readonly count: number;
  /** Pending tweens (deque at +0x4; size +0x14). */
  private queue: TweenEntry[] = [];
  /** 0 idle, 1 running (+0x20). */
  state = 0;
  /** Current values (+0x24), start (+0x28), target (+0x2c). */
  readonly current: Float32Array;
  readonly start: Float32Array;
  readonly target: Float32Array;
  /** Exponent (+0x30), progress 0..1 (+0x34), 1/frames (+0x38). */
  power = 0;
  t = 0;
  invFrames = 0;

  /** 0x1000bbe0: all values zero. */
  constructor(count: number) {
    this.count = count;
    this.current = new Float32Array(count);
    this.start = new Float32Array(count);
    this.target = new Float32Array(count);
  }

  /** Number of queued tweens (+0x14). */
  get queued(): number {
    return this.queue.length;
  }

  /** Running or queued (the test used by `IsAnimating` 0x100108f0 and timeline removal). */
  get busy(): boolean {
    return this.state !== 0 || this.queue.length !== 0;
  }

  /**
   * 0x1000c220. With `frames > 0` the tween is queued; unless `queue` (player `p+0x30`) is set
   * the queue is cleared and the running tween dropped first. Otherwise the values are set
   * immediately and the queue cleared.
   */
  set(values: ArrayLike<number>, frames: number, power: number, queue: boolean): void {
    const fr = f32(frames);
    if (fr > 0) {
      if (!queue) {
        this.queue = [];
        this.state = 0;
      }
      const v = new Float32Array(this.count);
      for (let i = 0; i < this.count; i++) v[i] = values[i] ?? 0;
      this.queue.push({values: v, frames: fr, power: f32(power)});
      return;
    }
    this.queue = [];
    this.state = 0;
    for (let i = 0; i < this.count; i++) this.current[i] = values[i] ?? 0;
  }

  /**
   * 0x1000c300. Idle with a queued entry: starts it (no progress in this call). Running:
   * advances by `frames`; at `t >= 1` the target is reached and the tween goes idle. Returns
   * the current values (the native copies them to the caller's output).
   */
  step(frames: number): Float32Array {
    if (this.state === 0) {
      const entry = this.queue.shift();
      if (entry) {
        for (let i = 0; i < this.count; i++) {
          this.start[i] = this.current[i]!;
          this.target[i] = entry.values[i]!;
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
        for (let i = 0; i < this.count; i++) {
          const s = this.start[i]!;
          this.current[i] = f32((this.target[i]! - s) * k + s);
        }
      } else {
        this.t = 1;
        this.current.set(this.target);
        this.state--;
      }
    }
    return this.current;
  }

  /**
   * 0x1000c180 (also inlined in 0x100198d0): finishes at once. With queued entries the last
   * one's values become current and the queue is cleared; otherwise a running tween jumps to
   * its target.
   */
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

  /** 0x1000bd90 + 0x1000c100 (`AssignState`): copies the complete state of `source`. */
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
