/** Native CBaseVideoRenderer quality data, in 100 ns units except proportion. */
export interface AokanaMovieQuality {
  type: 0 | 1;
  proportion: number;
  late: bigint;
  timestamp: bigint;
}

export interface AokanaMovieRenderDecision {
  /** S_OK draws now; S_FALSE schedules start; E_FAIL drops the sample. */
  status: 0 | 1 | 0x80004005;
  start: bigint;
  end: bigint;
}

const signed64 = (value: bigint): bigint => BigInt.asIntN(64, value);
const low32 = (value: bigint): number => Number(BigInt.asIntN(32, value));
const divide32 = (value: number, divisor: number): number => {
  value |= 0;
  divisor |= 0;
  if (divisor === 0 || (value === -0x80000000 && divisor === -1)) {
    throw new RangeError('Aokana movie quality integer division faults');
  }
  return Math.trunc(value / divisor) | 0;
};
const limitTime = (value: bigint): number =>
  Number(value < -500000000n ? -500000000n : value > 500000000n ? 500000000n : value);

/**
 * The exact renderer policy linked into aokana.exe. The codec reports the actual
 * upstream IQualityControl result separately; this class never invents codec
 * quality support or decides which decoded samples the codec emits.
 */
export class AokanaMovieRenderTiming {
  normalCount = 0; // +168, -1 means the preceding scheduling attempt dropped.
  supplierHandling = 0; // +16c
  throttle = 0; // +170
  renderAverage = 0; // +174
  renderLast = 0; // +178
  renderStartMilliseconds = 0; // +17c, raw timeGetTime DWORD
  earliness = 0; // +180
  target = -300000; // +184
  waitAverage = 0; // +188
  frameAverage = -1; // +18c
  duration = 0; // +190
  rememberedStamp = 0n; // +198
  dropped = 0; // +1a0
  drawn = 0; // +1a4
  latenessSum = 0n; // +1a8
  latenessSquares = 0n; // +1b0
  lastDraw = -1000n; // +1b8
  intervalSquares = 0n; // +1c0
  intervalSum = 0n; // +1c8
  performanceLate = 0; // +1d0
  performanceInterval = 0; // +1d4
  streamingMilliseconds: number; // +1d8, start tick or completed elapsed time

  constructor(rawMilliseconds: number) {
    this.streamingMilliseconds = rawMilliseconds >>> 0;
  }

  /** 124020 also runs at OnStartStreaming; supplierHandling is not reset here. */
  reset(rawMilliseconds: number): void {
    this.normalCount = this.throttle = this.renderAverage = this.renderLast = 0;
    this.renderStartMilliseconds = this.earliness = this.waitAverage = this.duration = 0;
    this.rememberedStamp = 0n;
    this.dropped = this.drawn = 0;
    this.latenessSum = this.latenessSquares = this.intervalSquares = this.intervalSum = 0n;
    this.lastDraw = -1000n;
    this.performanceLate = this.performanceInterval = 0;
    this.frameAverage = -1;
    this.target = -300000;
    this.streamingMilliseconds = rawMilliseconds >>> 0;
  }

  /** 1241c0. */
  stopStreaming(rawMilliseconds: number): void {
    this.streamingMilliseconds = (rawMilliseconds - this.streamingMilliseconds) >>> 0;
  }

  /** 123b40 constructs this message before it queries/notifies the upstream pin. */
  quality(lateness: bigint, streamTime: bigint): AokanaMovieQuality {
    lateness = signed64(lateness);
    const frame = this.frameAverage | 0;
    const render = this.renderAverage | 0;
    const wait = this.waitAverage | 0;
    const type = frame < 0 || Math.imul(render, 2) < frame ? 0 : 1;
    let proportion = 1000;
    if (frame >= 0) {
      if (lateness > 0n) {
        proportion = (1000 - low32(lateness / 10000n)) | 0;
        if (proportion < 500) proportion = 500;
      } else if (wait > 20000 && lateness < -20000n) {
        if (frame <= wait || ((frame + 20000) | 0) <= wait) proportion = 2000;
        else {
          // Native IDIV precedes IMUL: replacing this with a fractional ratio differs.
          proportion = Math.imul(divide32(frame, (frame - wait + 20000) | 0), 1000);
          if (proportion > 2000) proportion = 2000;
        }
      }
    }
    return {
      type,
      proportion,
      late: signed64(BigInt(divide32(render, 2)) + lateness),
      timestamp: signed64(streamTime),
    };
  }

  /** The lateness passed to SendQuality by 123cb0, including its initial 8 ms bias. */
  sampleLateness(start: bigint, streamTime: bigint): number {
    start = signed64(start);
    if (start >= 80000n) start = signed64(start - 80000n);
    return limitTime(signed64(streamTime - start));
  }

  /** 1242e0 IQualityControl::Notify, whose this-pointer is object+160. */
  notify(proportion: number): 0 {
    proportion |= 0;
    this.throttle =
      proportion >= 1000 ? 0 : (divide32(388880000, (proportion + 167) | 0) - 330000) | 0;
    return 0;
  }

  /**
   * 123cb0. streamTime is IReferenceClock::GetTime() minus graph start, both
   * signed 64-bit. qualityStatus is the actual SendQuality HRESULT. A missing
   * upstream IQualityControl produces S_FALSE (1), as in 123b40.
   */
  decide(
    start: bigint,
    end: bigint,
    streamTime: bigint,
    qualityStatus: number,
    discontinuityStatus: number,
  ): AokanaMovieRenderDecision {
    start = signed64(start);
    end = signed64(end);
    streamTime = signed64(streamTime);
    if (start >= 80000n) {
      start = signed64(start - 80000n);
      end = signed64(end - 80000n);
    }
    this.rememberedStamp = start;
    const late = limitTime(signed64(streamTime - start));
    this.supplierHandling = (qualityStatus | 0) === 0 ? 1 : 0;
    const duration = low32(end - start);
    const tolerance = divide32(this.duration, 32);
    if (
      ((this.duration + tolerance) | 0) < duration ||
      duration < ((this.duration - tolerance) | 0)
    ) {
      this.frameAverage = this.duration = duration;
    }
    const justDropped =
      (this.supplierHandling !== 0 && (discontinuityStatus | 0) === 0) || this.normalCount === -1;
    this.earliness =
      late > 0
        ? 0
        : late >= this.earliness || justDropped
          ? late
          : (this.earliness - divide32(this.earliness, 8)) | 0;
    const oldWaitTimesThree = Math.imul(this.waitAverage, 3);
    const nextWait = divide32((oldWaitTimesThree - (late < 0 ? late : 0)) | 0, 4);
    const intervalBeforeLimit = signed64(streamTime - this.lastDraw);
    let interval = intervalBeforeLimit > 10000000n ? 10000000n : intervalBeforeLimit;
    if (this.frameAverage < Math.imul(this.renderAverage, 3)) {
      const acceptable =
        this.supplierHandling === 0
          ? Math.imul(late, 2) < duration
          : late <= Math.imul(duration, 4);
      if (!acceptable && this.waitAverage < 80001 && intervalBeforeLimit < 10000001n) {
        this.waitAverage = nextWait;
        this.normalCount = -1;
        return {status: 0x80004005, start, end};
      }
    }
    const drawImmediately =
      (justDropped ||
        (((divide32(duration, 16) + duration) | 0) < this.frameAverage &&
          Math.imul(duration, -10) < late)) &&
      late > -9000001;
    if (drawImmediately) {
      this.normalCount = 0;
      this.waitAverage = divide32(oldWaitTimesThree, 4);
      this.frameAverage = divide32((low32(interval) + Math.imul(this.frameAverage, 3)) | 0, 4);
      this.preparePerformance(late, low32(interval));
      this.lastDraw = streamTime;
      if (late < this.earliness) this.earliness = late;
      return {status: 0, start, end};
    }
    this.normalCount = (this.normalCount + 1) | 0;
    this.frameAverage = duration;
    start = signed64(start + BigInt(Math.max(-duration | 0, this.earliness)));
    this.waitAverage = nextWait;
    if (late >= 0) {
      this.lastDraw = streamTime;
      this.preparePerformance(late, low32(interval));
      return {status: 0, start, end};
    }
    interval = BigInt(limitTime(signed64(start - this.lastDraw)));
    this.lastDraw = start;
    this.preparePerformance(limitTime(signed64(start - this.rememberedStamp)), low32(interval));
    return {status: 1, start, end};
  }

  /** 123ff0 counts every failed base scheduling attempt, not just late drops. */
  recordSchedulingFailure(): void {
    this.dropped = (this.dropped + 1) | 0;
  }

  /** 121a30 stores measurements; only an actual draw adds them to the totals. */
  preparePerformance(lateness: number, interval: number): void {
    this.performanceLate = lateness | 0;
    this.performanceInterval = interval | 0;
  }

  /** 124110. The first two/three rendered frames are excluded from the sums. */
  recordFrame(lateness: number, interval: number): void {
    let milliseconds = divide32(lateness, 10000);
    if ((milliseconds + 1000) >>> 0 > 2000) {
      milliseconds = this.drawn < 2 ? 0 : milliseconds > 0 ? 1000 : -1000;
    }
    if (this.drawn > 1) {
      this.latenessSum = signed64(this.latenessSum + BigInt(milliseconds));
      this.latenessSquares = signed64(
        this.latenessSquares + BigInt(Math.imul(milliseconds, milliseconds)),
      );
    }
    if (this.drawn > 2) {
      let elapsed = divide32(interval, 10000) >>> 0;
      if (elapsed > 1000) elapsed = 1000;
      this.intervalSum = signed64(this.intervalSum + BigInt(elapsed));
      this.intervalSquares = signed64(this.intervalSquares + BigInt(Math.imul(elapsed, elapsed)));
    }
    this.drawn = (this.drawn + 1) | 0;
  }

  /** 1242a0, immediately before the title's image-sender callback. */
  renderStart(rawMilliseconds: number): void {
    this.recordFrame(this.performanceLate, this.performanceInterval);
    this.renderStartMilliseconds = rawMilliseconds >>> 0;
  }

  /** 124230; the returned Sleep duration must be performed by the receive task. */
  renderEnd(rawMilliseconds: number): number {
    const duration = Math.imul((rawMilliseconds - this.renderStartMilliseconds) | 0, 10000);
    if (duration < Math.imul(this.renderAverage, 2) || duration < Math.imul(this.renderLast, 2)) {
      this.renderAverage = divide32((duration + Math.imul(this.renderAverage, 3)) | 0, 4);
    }
    this.renderLast = duration;
    return this.throttleMilliseconds();
  }

  /** 1240c0 is the native direct-draw alternative to the render start/end pair. */
  directRender(): number {
    this.renderAverage = 0;
    this.renderLast = 5000000;
    this.recordFrame(this.performanceLate, this.performanceInterval);
    return this.throttleMilliseconds();
  }

  /** 1219f0 calls Sleep even when its argument is zero. */
  throttleMilliseconds(): number {
    return this.throttle > 0 ? divide32(this.throttle, 10000) : 0;
  }
}
