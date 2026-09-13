/** Aokana's millisecond clock, including native rollover and long-gap exclusion. */
export class AokanaNativeClock {
  suspensionEnabled = false;
  private suspended = false;
  private pauseOption = 0;
  private frozen = 0n;
  private previousLow = 0;
  private high = 0;
  private previousRaw = 0n;
  private excluded = 0n;
  private gapLimit = 500n;

  constructor(private readonly readRawTick32: () => number) {}

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
