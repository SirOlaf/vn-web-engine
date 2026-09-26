import type {AokanaCrtRandom} from './system-timing.js';

export interface AokanaParticleVector {
  x: number;
  y: number;
  z: number;
}
const zero = (): AokanaParticleVector => ({x: 0, y: 0, z: 0});

/** 095d10 consumes two CRT random values, including when the requested range is zero. */
export function aokanaParticleRandom(random: AokanaCrtRandom, maximum: number): number {
  maximum |= 0;
  const combined = (random.next() << 15) | random.next();
  const denominator = Math.abs((maximum + 1) | 0);
  if (denominator === 0) throw new RangeError('Aokana particle random range divides by zero');
  const remainder = combined % denominator;
  return (maximum < 0 ? -remainder : remainder) | 0;
}

/** DCParticleEnvAir, 0996b0, and the complete base DCParticleEnv state. */
export class AokanaParticleAir {
  interval = 0;
  enabled = 0;
  private vector = zero();
  private center: AokanaParticleVector | undefined;
  private spread: AokanaParticleVector | undefined;
  private durations: [number, number, number, number] | undefined;
  private steps: [number, number, number, number] | undefined;
  private phase: number | undefined;
  private duration: number | undefined;
  private progress: number | undefined;
  private first: AokanaParticleVector | undefined;
  private second: AokanaParticleVector | undefined;

  constructor(private readonly random: AokanaCrtRandom) {}

  /** 099350 exposes zero coordinates while the independent enable flag is clear. */
  current(): {enabled: number; vector: AokanaParticleVector} {
    return {enabled: this.enabled, vector: this.enabled !== 0 ? {...this.vector} : zero()};
  }

  /** 099380 invokes virtual08 even for a zero interval. */
  setInterval(interval: number): void {
    this.interval = interval >>> 0;
    this.recalculateSteps();
  }

  /** 099590 uses unsigned divisions and leaves the previous derived values for zero. */
  private recalculateSteps(): boolean {
    if (this.interval === 0) return false;
    // Before configuration, these writes merely carry unknown duration values
    // into equally unknown derived fields. A later Configure overwrites them;
    // preserve that state until a transition actually consumes the fields.
    this.steps = this.durations?.map((value) => Math.floor((value >>> 0) / this.interval)) as
      [number, number, number, number] | undefined;
    return true;
  }

  /** 099610 takes signed Q16 values, stores Q8 coordinates, then randomizes both endpoints. */
  configure(
    enabled: number,
    x: number,
    spreadX: number,
    y: number,
    spreadY: number,
    z: number,
    spreadZ: number,
    hold: number,
    holdSpread: number,
    transition: number,
    transitionSpread: number,
  ): void {
    this.center = {x: x >> 8, y: y >> 8, z: z >> 8};
    this.spread = {x: spreadX >> 8, y: spreadY >> 8, z: spreadZ >> 8};
    this.durations = [hold >>> 0, holdSpread >>> 0, transition >>> 0, transitionSpread >>> 0];
    this.enabled = enabled !== 0 && this.recalculateSteps() ? 1 : 0;
    this.beginHold(true);
  }

  private randomEndpoint(): AokanaParticleVector {
    if (this.center === undefined || this.spread === undefined)
      throw new Error('Aokana particle air reads unconfigured endpoint fields');
    const coordinate = (axis: keyof AokanaParticleVector): number =>
      (aokanaParticleRandom(this.random, this.spread![axis] * 2) +
        (this.center![axis] - this.spread![axis])) |
      0;
    return {x: coordinate('x'), y: coordinate('y'), z: coordinate('z')};
  }

  private beginPhase(phase: number, duration: number): void {
    this.phase = phase;
    this.progress = 0;
    this.duration = (duration | 0) === 0 ? 1 : duration | 0;
  }

  /** 099420 retains the preceding target after each completed transition. */
  private beginHold(initial: boolean): void {
    if (this.steps === undefined)
      throw new Error('Aokana particle air reads unconfigured derived durations');
    this.beginPhase(0, (aokanaParticleRandom(this.random, this.steps[1]) + this.steps[0]) | 0);
    if (initial) this.first = this.randomEndpoint();
    else {
      if (this.second === undefined)
        throw new Error('Aokana particle air reads an unconfigured target');
      this.first = {...this.second};
    }
    this.second = this.randomEndpoint();
  }

  /** 099490 alternates held velocity and wrapped-integer linear transitions. */
  advance(): void {
    if (this.enabled === 0) {
      this.vector = zero();
      return;
    }
    if (
      this.phase === undefined ||
      this.progress === undefined ||
      this.duration === undefined ||
      this.first === undefined ||
      this.second === undefined ||
      this.steps === undefined
    )
      throw new Error('Aokana particle air reads an unconfigured transition');
    if (this.phase === 0) this.vector = {...this.first};
    else if (this.phase === 1) {
      const remaining = (this.duration - this.progress) | 0;
      const interpolate = (axis: keyof AokanaParticleVector): number => {
        const numerator =
          (Math.imul(this.second![axis], this.progress!) +
            Math.imul(this.first![axis], remaining)) |
          0;
        if (this.duration === 0 || (numerator === -0x80000000 && this.duration === -1))
          throw new RangeError(
            'Aokana particle air interpolation divides outside signed DWORD range',
          );
        return Math.trunc(numerator / this.duration!) | 0;
      };
      this.vector = {x: interpolate('x'), y: interpolate('y'), z: interpolate('z')};
    }
    this.progress = (this.progress + 1) | 0;
    if (this.duration >>> 0 <= this.progress >>> 0) {
      if (this.phase === 0)
        this.beginPhase(1, (aokanaParticleRandom(this.random, this.steps[3]) + this.steps[2]) | 0);
      else if (this.phase === 1) this.beginHold(false);
    }
  }
}
