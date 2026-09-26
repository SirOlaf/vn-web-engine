import type {BurikoNativeInput} from './input.js';

/** Buriko's millisecond clock, including native rollover and long-gap exclusion. */
export class BurikoNativeClock {
  private standaloneSuspensionEnabled = false;
  private suspensionInput: BurikoNativeInput | null = null;
  private suspended = false;
  private pauseOption = 0;
  private frozen = 0n;
  private previousLow = 0;
  private high = 0;
  private previousRaw = 0n;
  private excluded = 0n;
  private gapLimit = 500n;

  constructor(private readonly readRawTick32: () => number) {}

  /** FE670/FE6D0 read the live 1e8b7c input bit in a composed engine. */
  bindSuspensionInput(input: BurikoNativeInput): void {
    if (this.suspensionInput !== null)
      throw new Error('Buriko clock suspension input is already bound');
    if (!input.usesClock(this))
      throw new Error('Buriko clock suspension requires its shared input owner');
    this.suspensionInput = input;
  }

  get suspensionEnabled(): boolean {
    return this.suspensionInput?.inputActive ?? this.standaloneSuspensionEnabled;
  }

  /** Standalone fixtures retain their explicit native-bit setup. */
  set suspensionEnabled(value: boolean) {
    if (this.suspensionInput !== null)
      throw new Error('Buriko bound clock reads the live input-active bit');
    this.standaloneSuspensionEnabled = value;
  }

  /** 0x1400fe730 uses an unsigned raw clock and returns a signed 64-bit elapsed value. */
  read(): bigint {
    const low = this.readRawTick32() >>> 0;
    if (low < this.previousLow) this.high = (this.high + 1) >>> 0;
    this.previousLow = low;
    const raw = (BigInt(this.high) << 32n) | BigInt(low);
    if (BigInt.asUintN(64, this.gapLimit + this.previousRaw) < raw) {
      this.excluded = BigInt.asIntN(64, this.excluded + raw - this.previousRaw);
    }
    this.previousRaw = raw;
    return this.frozen !== 0n ? this.frozen : BigInt.asIntN(64, raw - this.excluded);
  }

  setGapLimit(milliseconds: number): boolean {
    milliseconds >>>= 0;
    if ((milliseconds - 50) >>> 0 >= 0xea2f) return false;
    this.gapLimit = BigInt(milliseconds);
    return true;
  }

  setPauseOption(value: number): number {
    const previous = this.pauseOption;
    this.pauseOption = value | 0;
    return previous;
  }

  /** B6320 reads the same FE660 option before suspending surface movies. */
  get pauseOptionEnabled(): boolean {
    return this.pauseOption !== 0;
  }

  beginSuspension(force: boolean): boolean {
    let result = false;
    if (this.suspensionEnabled && !this.suspended) {
      if ((this.pauseOption !== 0 || force) && this.frozen === 0n) {
        this.frozen = this.read();
        result = true;
      }
      this.suspended = true;
    }
    return result;
  }

  endSuspension(): boolean {
    let result = false;
    if (this.suspensionEnabled && this.suspended) {
      const frozen = this.frozen;
      if (frozen !== 0n) {
        this.frozen = 0n;
        const current = this.read();
        this.excluded = BigInt.asIntN(64, this.excluded + current - frozen);
        result = true;
      }
      this.suspended = false;
    }
    return result;
  }
}
