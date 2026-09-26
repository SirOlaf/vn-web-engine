import type {BurikoBpThread} from '../bp/state.js';
import {BurikoProcedure, BurikoProcedureState} from './procedure.js';
import {BurikoNativeClock} from './clock.js';
import {BurikoNativeInput} from './input.js';
import {BurikoNativeDisplayState} from './display-state.js';
import {BurikoCrtRandom} from './system-timing.js';
import {burikoShakeTarget} from './shake-math.js';

function divide(numerator: number, denominator: number): number {
  numerator |= 0;
  denominator |= 0;
  if (denominator === 0 || (numerator === -2147483648 && denominator === -1))
    throw new Error('Buriko shake native signed division fault');
  return Math.trunc(numerator / denominator) | 0;
}

/** CProcShakeScreen shares the ordinary presentation gate and the native procedure/input owners. */
export class BurikoShakeProcess extends BurikoProcedure {
  active = 0;
  capture = 0;
  mode = 0;
  amplitude = 0;
  cycleFrequency = 0;
  cycles = 0;
  decay = 0;
  tickFrequency = 0;
  steps = 0;
  cycle = 0;
  phase = 0;
  oscillation = 0;
  velocity = 0;
  target: readonly [number, number] = [0, 0];
  private previous: readonly [number, number] = [0, 0];
  private delta: readonly [number, number] = [0, 0];
  private activity = 0;
  constructor(
    thread: BurikoBpThread,
    shared: BurikoProcedureState,
    clock: BurikoNativeClock,
    readonly input: BurikoNativeInput,
    readonly display: BurikoNativeDisplayState,
    readonly random: BurikoCrtRandom,
    readonly presentTransient: (x: number, y: number) => number | Promise<number>,
  ) {
    super(thread, shared, clock);
    display.ordinaryPresentationEnabled = 0;
  }

  initialize(
    mode: number,
    amplitude: number,
    frequency: number,
    cycles: number,
    decay: number,
    tickFrequency: number,
    capture: number,
  ): number {
    if (mode >>> 0 > 3) return 0x80000001;
    if ((frequency | 0) <= 0) return 0x80000002;
    if ((cycles | 0) <= 0) return 0x80000003;
    if ((tickFrequency | 0) < 1 || (tickFrequency | 0) < (frequency | 0)) return 0x80000004;
    if (this.capture !== 0) {
      this.input.releasePointerCapture(0xffffffff);
      this.input.releaseKeyCapture(0xffffffff);
    }
    this.steps = divide(tickFrequency, frequency);
    this.mode = mode | 0;
    this.amplitude = amplitude << 11;
    this.cycleFrequency = frequency | 0;
    this.cycles = cycles | 0;
    this.decay = decay | 0;
    this.tickFrequency = tickFrequency | 0;
    this.capture = capture | 0;
    this.cycle = this.phase = 0;
    this.target = [0, 0];
    if (this.capture !== 0) {
      this.input.installPointerCapture(0xffffffff);
      this.input.installKeyCapture(0xffffffff);
      this.input.collect(0xffffffff, 0xffffffff);
      this.activity = this.input.inputEventCount;
    }
    this.setDeadline(0);
    this.active = 1;
    return 0;
  }

  async poll(): Promise<number> {
    this.consumeMessages();
    if (this.active !== 0) {
      let continuing = this.capture === 0 || this.activity === this.input.inputEventCount;
      if (continuing && this.deadlineReached()) {
        this.deadline = (this.deadline + divide(1000, this.tickFrequency)) >>> 0;
        if (this.phase === 0) {
          this.oscillation = 0;
          this.velocity = divide(this.amplitude << 2, this.steps);
          this.previous = this.target;
          this.target = burikoShakeTarget(
            this.random,
            this.mode,
            this.amplitude,
            this.cycle & 3,
            this.target,
          );
          this.delta = [
            (this.target[0] - this.previous[0]) | 0,
            (this.target[1] - this.previous[1]) | 0,
          ];
        }
        this.oscillation = (this.oscillation + this.velocity) | 0;
        const lower = -this.amplitude | 0;
        if (this.oscillation > this.amplitude || this.oscillation < lower)
          this.velocity = -this.velocity | 0;
        if (this.oscillation > this.amplitude)
          this.oscillation = (Math.imul(this.amplitude, 2) - this.oscillation) | 0;
        if (this.oscillation < lower)
          this.oscillation = (Math.imul(this.amplitude, -2) - this.oscillation) | 0;
        if (!this.deadlineReached()) {
          let x = this.mode === 0 || this.mode === 2 ? this.oscillation : 0;
          let y = this.mode === 1 || this.mode === 2 ? this.oscillation : 0;
          if (this.mode === 3) {
            x = (divide(Math.imul(this.delta[0], this.phase), this.steps) + this.previous[0]) | 0;
            y = (divide(Math.imul(this.delta[1], this.phase), this.steps) + this.previous[1]) | 0;
          }
          await this.presentTransient(x >> 12, y >> 12);
        }
        this.phase = (this.phase + 1) | 0;
        if (this.phase >= this.steps) {
          this.cycle = (this.cycle + 1) | 0;
          this.phase = 0;
          this.amplitude = divide(Math.imul((100 - this.decay) | 0, this.amplitude), 100);
          continuing = this.cycle < this.cycles;
        }
      }
      this.active = Number(continuing);
      if (!continuing) {
        await this.presentTransient(0, 0);
        return 1;
      }
    }
    if (this.canRun()) return 0;
    await this.presentTransient(0, 0);
    return 1;
  }

  override dispose(): void {
    if (this.capture !== 0) {
      this.input.collect(0xffffffff, 0xffffffff);
      this.input.releasePointerCapture(0xffffffff);
      this.input.releaseKeyCapture(0xffffffff);
    }
    this.display.ordinaryPresentationEnabled = 1;
    super.dispose();
  }
}
