import {AokanaNativeInput} from './input.js';
import {AokanaNativeClock} from './clock.js';

/** Shared 1D03C8/1D03CC policy used by the synchronous-versus-procedure bitmap load branch. */
export class AokanaBitmapLoadState {
  delay = 0;
  deadline = 0;
  constructor(
    readonly input: AokanaNativeInput,
    readonly clock: AokanaNativeClock,
  ) {}

  /** 037240 resets the saved deadline even when the delay does not change. */
  setDelay(value: number): void {
    this.delay = value | 0;
    this.deadline = 0;
  }

  /** 0371D0 tests the input skip state before its exact unsigned deadline branches. */
  skipLoadWait(): number {
    const skip = Number(this.input.skipRequested());
    if (this.delay === 0) {
      if (skip === 0) this.deadline = 0;
      return skip;
    }
    if (this.deadline === 0)
      this.deadline = (Number(BigInt.asUintN(32, this.clock.read())) + this.delay) >>> 0;
    else if (skip === 0 && this.deadline <= Number(BigInt.asUintN(32, this.clock.read()))) {
      this.deadline = 0;
      return 0;
    }
    return 1;
  }
}
