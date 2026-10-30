import {artemisRevision} from './revision.js';

// Native float literals widened to double (0x1403fbf78..0x1403fc200).
const halfPi = 1.5707963705062866,
  pi = 3.1415927410125732,
  twoPi = 6.2831854820251465,
  backOvershoot = 1.7015800476074219,
  backInOutScale = 1.524999976158142,
  elasticPeriod = 0.30000001192092896,
  elasticInOutPeriod = 0.45000001788139343;
// Bounce thresholds and offsets 0x1403fbf98..0x1403fbff0, 0x1403fc1d8..0x1403fc1e8.
const bounce = [
  [0.7272727489471436, -0.5454545617103577, 0.75],
  [0.9090909361839294, -0.8181818127632141, 0.9375],
  [Infinity, -0.9545454382896423, 0.984375],
] as const;

/** easeOutBounce 0x1400f17b0(t, b, c, d). */
function bounceOut(t: number, b: number, c: number, d: number): number {
  t = t / d;
  if (t < 0.3636363744735718) return t * 7.5625 * t * c + b;
  for (const [limit, offset, base] of bounce)
    if (t < limit) return ((t + offset) * 7.5625 * (t + offset) + base) * c + b;
  throw Error('unreachable');
}
/** CVTTSD2SI followed by the integer absolute value used by the elastic amplitude test. */
function truncatedMagnitude(value: number): number {
  const int =
    Number.isFinite(value) && value > -2147483649 && value < 2147483648
      ? Math.trunc(value)
      : -0x80000000;
  return int === -0x80000000 ? int : Math.abs(int);
}
function elasticShift(c: number, a: number, p: number): {a: number; s: number} {
  if (a === 0 || truncatedMagnitude(c) > a) return {a: c, s: p * 0.25};
  return {a, s: Math.asin(c / a) * (p / twoPi)};
}

/** Curve switch shared by TTween<int> 0x1400eccf0 and TTween<float> 0x1400ee310.
 * `t` is elapsed milliseconds, `b` the start, `c` the change and `d` the duration.
 * `a` (+0x10) is the back overshoot or elastic amplitude, `p` (+0x18) the elastic period.
 * Ease 0 and values outside 1..30 are linear. */
export function artemisEase(
  ease: number,
  t: number,
  b: number,
  c: number,
  d: number,
  a = 0,
  p = 0,
): number {
  switch (ease) {
    case 1:
      t /= d;
      return c * t * t + b;
    case 2:
      return b - c * (t / d) * (t / d - 2);
    case 3:
      t /= d * 0.5;
      if (t < 1) return c * 0.5 * t * t + b;
      return b - ((t - 1 - 2) * (t - 1) - 1) * c * 0.5;
    case 4:
      t /= d;
      return c * t * t * t + b;
    case 5:
      t = t / d - 1;
      return (t * t * t + 1) * c + b;
    case 6:
      t /= d * 0.5;
      if (t < 1) return c * 0.5 * t * t * t + b;
      t -= 2;
      return (t * t * t + 2) * c * 0.5 + b;
    case 7:
      t /= d;
      return c * t * t * t * t + b;
    case 8:
      t = t / d - 1;
      return b - (t * t * t * t - 1) * c;
    case 9:
      t /= d * 0.5;
      if (t < 1) return c * 0.5 * t * t * t * t + b;
      t -= 2;
      return b - (t * t * t * t - 2) * c * 0.5;
    case 10:
      t /= d;
      return c * t * t * t * t * t + b;
    case 11:
      t = t / d - 1;
      return (t * t * t * t * t + 1) * c + b;
    case 12:
      t /= d * 0.5;
      if (t < 1) return c * 0.5 * t * t * t * t * t + b;
      t -= 2;
      return (t * t * t * t * t + 2) * c * 0.5 + b;
    case 13:
      return t === 0 ? b : Math.pow(2, (t / d - 1) * 10) * c + b;
    case 14:
      return t === d ? c + b : (1 - Math.pow(2, (t * -10) / d)) * c + b;
    case 15:
      if (t === 0) return b;
      if (t === d) return c + b;
      t /= d * 0.5;
      if (t >= 1) return (2 - Math.pow(2, (t - 1) * -10)) * c * 0.5 + b;
      return Math.pow(2, (t - 1) * 10) * c * 0.5 + b;
    case 16:
      return b - (Math.sqrt(1 - (t / d) * (t / d)) - 1) * c;
    case 17:
      t = t / d - 1;
      return Math.sqrt(1 - t * t) * c + b;
    case 18:
      t /= d * 0.5;
      if (t >= 1) return (Math.sqrt(1 - (t - 2) * (t - 2)) + 1) * c * 0.5 + b;
      return b - (Math.sqrt(1 - t * t) - 1) * c * 0.5;
    case 19:
      return c - Math.cos((t / d) * halfPi) * c + b;
    case 20:
      return Math.sin((t / d) * halfPi) * c + b;
    case 21:
      return b - (Math.cos((t * pi) / d) - 1) * (c * 0.5);
    case 22: {
      const s = a === 0 ? backOvershoot : a;
      t /= d;
      return ((s + 1) * t - s) * c * t * t + b;
    }
    case 23: {
      const s = a === 0 ? backOvershoot : a;
      t = t / d - 1;
      return (((s + 1) * t + s) * t * t + 1) * c + b;
    }
    case 24: {
      const s = (a === 0 ? backOvershoot : a) * backInOutScale;
      t /= d * 0.5;
      if (t < 1) return ((s + 1) * t - s) * t * t * c * 0.5 + b;
      t -= 2;
      return (((s + 1) * t + s) * (t * t) + 2) * c * 0.5 + b;
    }
    case 25: {
      if (t === 0) return b;
      t /= d;
      if (t === 1) return c + b;
      const period = p === 0 ? d * elasticPeriod : p,
        shift = elasticShift(c, a, period);
      t -= 1;
      const wave = Math.sin(((d * t - shift.s) * twoPi) / period);
      return b - wave * (Math.pow(2, t * 10) * shift.a);
    }
    case 26: {
      if (t === 0) return b;
      t /= d;
      if (t === 1) return c + b;
      const period = p === 0 ? d * elasticPeriod : p,
        shift = elasticShift(c, a, period);
      const wave = Math.sin(((d * t - shift.s) * twoPi) / period);
      return wave * (Math.pow(2, t * -10) * shift.a) + c + b;
    }
    case 27: {
      if (t === 0) return b;
      t /= d * 0.5;
      if (t === 2) return c + b;
      const period = p === 0 ? d * elasticInOutPeriod : p,
        shift = elasticShift(c, a, period),
        first = t < 1;
      t -= 1;
      const wave = Math.sin(((d * t - shift.s) * twoPi) / period);
      if (first) return b - wave * (Math.pow(2, t * 10) * shift.a) * 0.5;
      return wave * (Math.pow(2, t * -10) * shift.a) * 0.5 + c + b;
    }
    case 28:
      return c - bounceOut(d - t, 0, c, d) + b;
    case 29:
      return bounceOut(t, b, c, d);
    case 30:
      if (d * 0.5 <= t) return bounceOut(t + t - d, 0, c, d) * 0.5 + c * 0.5 + b;
      return (c - bounceOut(d - (t + t), 0, c, d) + 0) * 0.5 + b;
    default:
      return (c / d) * t + b;
  }
}

/** Native `ease` spellings in dispatch order 1..30 (lytween 0x1400da830, scetween). */
export const artemisEaseNames = [
  'quad',
  'cubic',
  'quart',
  'quint',
  'expo',
  'circ',
  'sine',
  'back',
  'elastic',
  'bounce',
].flatMap((family) => ['easein_', 'easeout_', 'easeinout_'].map((kind) => kind + family));
/** Exact-match ease id; absent or unknown spellings stay 0 (linear). */
export function artemisEaseId(name: string | undefined): number {
  return name === undefined ? 0 : artemisEaseNames.indexOf(name) + 1;
}

export interface ArtemisTweenOptions {
  /** +8 curve id. */
  readonly ease?: number;
  /** +0x34 start delay (int, added to the first tick time). */
  readonly delay?: number;
  /** +0x40 extra plays; -1 repeats forever. Takes precedence over yoyo. */
  readonly loop?: number;
  /** +0x44 reversals; -1 reverses forever. */
  readonly yoyo?: number;
  /** +0x48 pause between plays. */
  readonly loopDelay?: number;
}
function uint32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw Error(`Unsupported Artemis uint32 tween ${name}`);
}
function int32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff)
    throw Error(`Unsupported Artemis int32 tween ${name}`);
}

/** TTween<T> state machine (constructor 0x1400ef000; step 0x1400eccf0/0x1400ee310; finish
 * 0x1400ecbd0/0x1400ee280). Timing initializes on the first tick (start = delay + now,
 * zero start is the uninitialized sentinel) and compares absolute uint32 times, including
 * wrap. Interpolation is float64; `convert` maps the value for the typed setter. */
export class ArtemisTween {
  private start = 0;
  private end = 0;
  private completed = false;
  private source: number;
  private target: number;
  private loops: number;
  private reversals: number;
  private reversed = false;
  readonly ease: number;
  readonly delay: number;
  readonly loopDelay: number;
  private completion: () => void;
  constructor(
    hash: string,
    from: number,
    to: number,
    readonly milliseconds: number,
    private readonly apply: (value: number) => void,
    onComplete: () => void = () => {},
    options: ArtemisTweenOptions = {},
  ) {
    artemisRevision(hash);
    if (!Number.isFinite(from) || !Number.isFinite(to))
      throw Error('Unsupported Artemis tween endpoint');
    uint32(milliseconds, 'duration');
    this.ease = options.ease ?? 0;
    this.delay = options.delay ?? 0;
    this.loops = options.loop ?? 0;
    this.reversals = options.yoyo ?? 0;
    this.loopDelay = options.loopDelay ?? 0;
    int32(this.ease, 'curve');
    int32(this.delay, 'delay');
    int32(this.loops, 'loop');
    int32(this.reversals, 'yoyo');
    int32(this.loopDelay, 'loop delay');
    this.source = from;
    this.target = to;
    this.completion = onComplete;
  }
  get from(): number {
    return this.source;
  }
  get to(): number {
    return this.target;
  }
  get done(): boolean {
    return this.completed;
  }
  /** +0x4c toggles on every yoyo reversal. */
  get reversedDirection(): boolean {
    return this.reversed;
  }
  /** ecc70 replaces the completion functor (+0x78). */
  setCompletion(onComplete: () => void): void {
    this.completion = onComplete;
  }
  /** Marks the tween done without applying a value or running its completion. */
  cancel(): void {
    this.completed = true;
  }
  /** Finish: a pending odd yoyo count ends on the current start value, otherwise the
   * target. Applies it, marks done, then runs the completion. */
  finish(): void {
    if (this.completed) return;
    this.apply(this.convert(this.reversals >= 1 && this.reversals & 1 ? this.source : this.target));
    this.completed = true;
    this.completion();
  }
  protected convert(value: number): number {
    return value;
  }
  /** One registry step; true when the tween is done and may be destroyed. */
  tick(now: number): boolean {
    uint32(now, 'clock');
    if (this.completed) return true;
    if (this.start === 0) {
      this.start = (this.delay + now) >>> 0;
      this.end = (this.milliseconds + this.start) >>> 0;
    }
    if (now <= this.start) {
      this.apply(this.convert(this.source));
      return false;
    }
    if (this.end <= now) {
      if (this.loops === 0 && this.reversals === 0) {
        this.apply(this.convert(this.target));
        this.completed = true;
        this.completion();
        return true;
      }
      const overshoot = (now - this.end) >>> 0;
      this.start = (this.loopDelay - (overshoot < this.milliseconds ? overshoot : 0) + now) >>> 0;
      this.end = (this.milliseconds + this.start) >>> 0;
      if (this.loops === 0) {
        if (this.reversals !== -1) this.reversals--;
        [this.source, this.target] = [this.target, this.source];
        this.reversed = !this.reversed;
      } else if (this.loops !== -1) this.loops--;
      if (now <= this.start) {
        this.apply(this.convert(this.source));
        return false;
      }
    }
    this.apply(
      this.convert(
        artemisEase(
          this.ease,
          (now - this.start) >>> 0,
          this.source,
          this.target - this.source,
          this.milliseconds,
        ),
      ),
    );
    return false;
  }
}

/** TTween<float> 0x1400ef000: values reach the setter rounded to float32. */
export class ArtemisFloatTween extends ArtemisTween {
  protected override convert(value: number): number {
    return Math.fround(value);
  }
}

export interface ArtemisRegisteredTween {
  tick(now: number): boolean;
  finish(): void;
}

/** CTweenQueue (vtable 0x140369e78), a deque of tweens registered as one entry. Step
 * 0x1400a57b0 runs only the front tween; when it is done it is destroyed and the next one
 * steps with the same clock, so the queued tweens play one after another and each one's
 * timing starts on its first step. Empty reports done. Cancel 0x1400a58c0 marks every
 * tween done without applying a value; finish 0x1400a5990 finishes each in order; both
 * then empty the queue. */
export class ArtemisTweenQueue implements ArtemisRegisteredTween {
  private readonly tweens: ArtemisTween[] = [];
  constructor(hash: string) {
    artemisRevision(hash);
  }
  get size(): number {
    return this.tweens.length;
  }
  /** 0x1400a56f0 push_back. */
  append(tween: ArtemisTween): void {
    this.tweens.push(tween);
  }
  tick(now: number): boolean {
    while (this.tweens.length) {
      if (!this.tweens[0]!.tick(now)) return false;
      this.tweens.shift();
    }
    return true;
  }
  cancel(): void {
    for (const tween of this.tweens.splice(0)) tween.cancel();
  }
  finish(): void {
    for (const tween of this.tweens.splice(0)) tween.finish();
  }
}

/** Global tween registry: register 0x1400a5360, frame step 0x14019aa00, finish 0x1400a54b0.
 * Ids come from one global uint32 counter. Registrations made while stepping go to a
 * pending map that is merged after the step. Steps visit tweens in registration order
 * (the native hash-list order is not reconstructed). A finished tween stays registered
 * until a step reports it done, then it is destroyed. */
export class ArtemisTweenRegistry {
  private readonly active = new Map<number, ArtemisRegisteredTween>();
  private readonly pending = new Map<number, ArtemisRegisteredTween>();
  private ticking = false;
  private counter = 0;
  constructor(hash: string) {
    artemisRevision(hash);
  }
  get size(): number {
    return this.active.size + this.pending.size;
  }
  register(tween: ArtemisRegisteredTween): number {
    const id = this.counter;
    (this.ticking ? this.pending : this.active).set(id, tween);
    this.counter = (this.counter + 1) >>> 0;
    return id;
  }
  /** 0x140149760: true while the id is registered (active or pending), including a
   * finished tween that no step has removed yet. */
  has(id: number): boolean {
    return this.active.has(id) || this.pending.has(id);
  }
  /** Finishes the active tween with this id, else the pending one; unknown ids are ignored. */
  finish(id: number): void {
    (this.active.get(id) ?? this.pending.get(id))?.finish();
  }
  tick(now: number): void {
    if (this.ticking) throw Error('Reentrant Artemis tween registry step');
    this.ticking = true;
    try {
      for (const [id, tween] of this.active) if (tween.tick(now)) this.active.delete(id);
    } finally {
      this.ticking = false;
      for (const [id, tween] of this.pending) this.active.set(id, tween);
      this.pending.clear();
    }
  }
  /** Drops every registration without finishing it. */
  clear(): void {
    this.active.clear();
    this.pending.clear();
  }
}
