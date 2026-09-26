import type {BurikoNativeClock} from './clock.js';
import type {BurikoNativePerformanceCounter} from './system-timing.js';

export interface BurikoFrameMetricRaster {
  /** B3050 result, including its raw-adapter zero -> 60 fallback. */
  readonly refreshRate: number;
  readRasterScanline(output: {scanline?: number}): number;
}
const int64 = (value: number): bigint =>
  Number.isFinite(value) && value >= -(2 ** 63) && value < 2 ** 63
    ? BigInt(Math.trunc(value))
    : -(1n << 63n);
const dword = (value: number): number => Number(BigInt.asUintN(32, int64(value)));

/** 1d0390..1d03b8: simulation intervals accumulate until a draw commits one measured frame. */
export class BurikoFrameMetrics {
  enabled = 0;
  private startCounter = 0n;
  private startScanline = 0; // 1d033c has static zero initialization.
  private threshold = 0n;
  private total = 0n;
  private pending = 0n;
  private frames = 0;
  private good = 0;
  constructor(
    readonly counter: BurikoNativePerformanceCounter,
    readonly clock: BurikoNativeClock,
    readonly raster: BurikoFrameMetricRaster,
  ) {}
  private readCounter(): bigint {
    return BigInt.asIntN(64, this.counter.queryCounter() ?? this.clock.read());
  }
  private readFrequency(): bigint {
    return BigInt.asIntN(64, this.counter.queryFrequency() ?? 1000n);
  }

  /** 031ed0 nonzero enable restarts statistics; disabling retains all accumulated fields. */
  enable(value: number): void {
    this.enabled = value | 0;
    if (this.enabled === 0) return;
    const refresh = this.raster.refreshRate >>> 0;
    if (refresh === 0) throw new RangeError('Buriko frame metric refresh period is zero');
    const period = this.readFrequency() / BigInt(refresh);
    this.threshold = BigInt.asIntN(64, period * 96n) / 100n;
    this.total = this.pending = 0n;
    this.frames = this.good = 0;
  }
  /** 031d40 leaves the existing start scanline intact on an ordinary query failure. */
  begin(): void {
    if (this.enabled === 0) return;
    this.startCounter = this.readCounter();
    const output: {scanline?: number} = {scanline: this.startScanline};
    const status = this.raster.readRasterScanline(output) >>> 0;
    this.startScanline = status === 0x81000000 ? 0xffffffff : output.scanline! >>> 0;
  }
  /** 031c90 commits after the object draw even when that draw could not lock the display. */
  end(commit: number): void {
    if (this.enabled === 0) return;
    const elapsed = BigInt.asIntN(64, this.pending - this.startCounter + this.readCounter());
    if ((commit | 0) === 0) {
      this.pending = elapsed;
      return;
    }
    this.total = BigInt.asIntN(64, this.total + elapsed);
    const output: {scanline?: number} = {};
    const status = this.raster.readRasterScanline(output) >>> 0;
    if (status === 0x81000000) output.scanline = 0xffffffff;
    if (this.startScanline !== 0xffffffff && output.scanline === undefined)
      throw new Error('Buriko frame metric raster query supplied no end scanline');
    if (
      (this.startScanline === 0xffffffff ||
        output.scanline === 0xffffffff ||
        this.startScanline <= output.scanline! >>> 0) &&
      elapsed < this.threshold
    )
      this.good = (this.good + 1) >>> 0;
    this.frames = (this.frames + 1) >>> 0;
    this.pending = 0n;
  }
  /** 031d90 preserves the separate binary64 arithmetic and final CVTT signed-64 conversion. */
  read(index: number): number {
    index |= 0;
    if (index === 0) return this.frames;
    if (index === 1)
      return this.frames === 0
        ? 0
        : dword((Number(this.total) / (this.frames * Number(this.readFrequency()))) * 1000000);
    if (index === 2)
      return this.total <= 0n
        ? 0
        : dword(((Number(this.threshold >> 1n) * this.frames) / Number(this.total)) * 10000);
    if (index === 3)
      return this.frames === 0
        ? 0
        : dword(((this.good * this.good) / (this.frames * this.frames)) * 10000);
    return 0;
  }
}
