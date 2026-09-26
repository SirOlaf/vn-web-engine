import type {BurikoMovieMediaType, BurikoMovieSample} from './movie-image.js';
import type {BurikoMovieImage} from './movie-image.js';
import {BurikoMovieFilterEvents} from './movie-filter-events.js';
import {
  BurikoMovieReferenceClock,
  BurikoMovieRenderEvents,
  burikoMovieThrottle,
  type BurikoMovieGraphClock,
} from './movie-render-events.js';
import {BurikoMovieRenderTiming, type BurikoMovieQuality} from './movie-render-timing.js';

export interface BurikoMovieSampleConsumer {
  readonly image: BurikoMovieImage;
  setMediaType(type: BurikoMovieMediaType): number;
  deliver(sample: BurikoMovieSample | null): number | Promise<number>;
}

export interface BurikoMovieTimedSample extends BurikoMovieSample {
  readonly time: {readonly start: bigint; readonly end: bigint} | null;
  readonly discontinuity: boolean;
  readonly mediaType?: BurikoMovieMediaType;
}

/**
 * CRendererInputPin/CBaseRenderer for the concrete WebCodecs filter profile.
 * This profile has no upstream IQualityControl endpoint; SendQuality therefore
 * returns S_FALSE after constructing the native quality message.
 */
export class BurikoMovieReceivePin {
  readonly events = new BurikoMovieRenderEvents();
  readonly timing: BurikoMovieRenderTiming;
  state: 0 | 1 | 2 = 0;
  streaming = false;
  connected = false;
  flushing = false;
  runtimeError = false;
  aborted = false;
  repaintEnabled = true;
  mediaPositionValid = false;
  mediaStart = 0n;
  mediaEnd = 0n;
  /** The connected source's current stop position, used by CRendererPosPassThru EOS. */
  sourceStopPosition = 0n;
  lastQuality: BurikoMovieQuality | null = null;
  private graphStart = 0n;
  private sampleEnd = 0n;
  private inputSampleEnd = 0n;
  private pending: BurikoMovieTimedSample | null = null;
  private endOfStreamSeen = false;
  private endOfStreamDelivered = false;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private renderBarrier: Promise<void> | null = null;
  private receiveBarrier: Promise<void> | null = null;
  private endReceive: (() => void) | null = null;
  private disposed = false;

  constructor(
    readonly renderer: BurikoMovieSampleConsumer,
    readonly graphEvents: BurikoMovieFilterEvents,
    readonly clock: BurikoMovieGraphClock | null,
    readonly rawClock = new BurikoMovieReferenceClock(),
  ) {
    this.timing = new BurikoMovieRenderTiming(rawClock.rawMilliseconds());
    this.graphEvents.addRenderer(this);
  }

  /** CompleteConnect/SetMediaType with the real title image sender and surface allocation. */
  connect(type: BurikoMovieMediaType): number {
    if (this.disposed) throw new Error('Buriko movie connects a released renderer');
    const checked = this.renderer.image.checkMediaType(type);
    if ((checked | 0) < 0) return checked;
    const set = this.renderer.setMediaType(type);
    if ((set | 0) < 0) return set;
    this.connected = true;
    this.aborted = false;
    this.repaintEnabled = this.state !== 2;
    if (this.state === 2) this.startStreaming();
    return 0;
  }

  get pendingSample(): BurikoMovieTimedSample | null {
    return this.pending;
  }

  private withRenderLock<T>(operation: () => T | Promise<T>): T | Promise<T> {
    return this.renderBarrier === null
      ? operation()
      : this.renderBarrier.then(() => this.withRenderLock(operation));
  }

  /** 123120. An already-running renderer does not change its stored graph start. */
  run(start: bigint): number | Promise<number> {
    return this.withRenderLock(() => {
      if (this.state === 2) return 0;
      if (!this.connected) {
        this.state = 2;
        this.graphEvents.notify(this, 1);
        return 0;
      }
      const previous = this.state;
      this.events.setReady(true);
      this.graphStart = BigInt.asIntN(64, start);
      this.state = 2;
      this.events.setAbort(true);
      this.repaintEnabled = false;
      if (previous === 0) {
        this.aborted = false;
        this.pending = null;
      }
      this.startStreaming();
      return 0;
    });
  }

  private startStreaming(): void {
    if (this.streaming) return;
    this.streaming = true;
    this.timing.reset(this.rawClock.rawMilliseconds());
    if (this.pending === null) this.sendEndOfStream();
    else if (!this.schedule(this.pending)) this.events.signalRender();
  }

  /** 123250 keeps an existing pending sample while canceling its old advise. */
  pause(): number | Promise<number> {
    return this.withRenderLock(() => {
      const previous = this.state;
      if (previous !== 1) {
        this.state = 1;
        if (this.connected) {
          this.repaintEnabled = true;
          this.stopStreaming();
          this.events.setAbort(true);
          this.events.cancelNotification();
          this.cancelEndTimer();
          if (previous === 0) {
            this.aborted = false;
            this.pending = null;
          }
        }
      }
      if (!this.connected || this.endOfStreamSeen || (this.pending !== null && previous !== 0)) {
        this.events.setReady(true);
        return 0;
      }
      this.events.setReady(false);
      return 1;
    });
  }

  private stopStreaming(): void {
    this.endOfStreamDelivered = false;
    if (this.streaming) {
      this.streaming = false;
      this.timing.stopStreaming(this.rawClock.rawMilliseconds());
    }
  }

  stop(): number | Promise<number> {
    return this.withRenderLock(() => {
      if (this.state === 0) return 0;
      this.state = 0;
      if (!this.connected) return 0;
      this.clearMediaPosition();
      this.pending = null;
      this.repaintEnabled = true;
      this.stopStreaming();
      this.events.setAbort(false);
      this.clearEndOfStream();
      this.events.cancelNotification();
      this.events.setReady(true);
      this.aborted = false;
      const barrier = this.receiveBarrier;
      return barrier === null ? 0 : barrier.then(() => 0);
    });
  }

  /** Receive's return includes CRendererInputPin's error notification wrapper (121bc0). */
  receive(sample: BurikoMovieTimedSample | null): number | Promise<number> {
    return this.withRenderLock(() => {
      const prepared = this.prepare(sample);
      if (prepared !== 0) return this.finishError(prepared === 0x8004022b ? 0 : prepared);
      this.receiveBarrier = new Promise((resolve) => {
        this.endReceive = resolve;
      });
      if (this.state === 1) this.events.setReady(true);
      const wait = this.events.waitForRender();
      return typeof wait === 'number'
        ? this.afterWait(wait)
        : wait.then((result) => this.afterWait(result));
    });
  }

  private prepare(sample: BurikoMovieTimedSample | null): number {
    // 1228a0 maps every nonzero CBaseInputPin::Receive result to E_FAIL.
    if (this.disposed || sample === null || this.state === 0 || this.flushing || this.runtimeError)
      return 0x80004005;
    if (sample.time !== null) this.inputSampleEnd = BigInt.asIntN(64, sample.time.end);
    if (sample.mediaType !== undefined) {
      if (this.renderer.image.checkMediaType(sample.mediaType) !== 0) {
        this.runtimeError = true;
        this.graphEvents.notify(this, 3, BigInt(0x8004022a | 0));
        return 0x80004005;
      }
      const result = this.renderer.setMediaType(sample.mediaType);
      if ((result | 0) < 0) return result;
    }
    if (this.pending !== null || this.endOfStreamSeen || this.aborted) {
      this.events.setReady(true);
      return 0x8000ffff;
    }
    if (sample.time !== null) {
      this.mediaStart = BigInt.asIntN(64, sample.time.start);
      this.mediaEnd = BigInt.asIntN(64, sample.time.end);
      this.mediaPositionValid = true;
    }
    if (this.streaming && !this.schedule(sample)) return 0x8004022b;
    this.sampleEnd = this.inputSampleEnd;
    this.pending = sample;
    if (!this.streaming) this.repaintEnabled = true;
    return 0;
  }

  private schedule(sample: BurikoMovieTimedSample): boolean {
    if (sample.time !== null) {
      const start = BigInt.asIntN(64, sample.time.start),
        end = BigInt.asIntN(64, sample.time.end);
      if (end < start) {
        this.timing.recordSchedulingFailure();
        return false;
      }
      if (this.clock !== null) {
        const now = BigInt.asIntN(64, this.clock.now() - this.graphStart);
        this.lastQuality = this.timing.quality(BigInt(this.timing.sampleLateness(start, now)), now);
        const decision = this.timing.decide(start, end, now, 1, sample.discontinuity ? 0 : 1);
        if ((decision.status | 0) < 0) {
          this.timing.recordSchedulingFailure();
          return false;
        }
        if (decision.status === 1) {
          this.events.advise(this.clock, this.graphStart, decision.start);
          return true;
        }
      }
    }
    this.events.signalRender();
    return true;
  }

  private afterWait(result: 0 | 0x80040223): number | Promise<number> {
    if (result !== 0 || this.disposed || this.state === 0) {
      this.finishReceive();
      return 0;
    }
    let release: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.renderBarrier = barrier;
    const finish = (): number => {
      this.pending = null;
      this.sendEndOfStream();
      this.events.cancelNotification();
      this.renderBarrier = null;
      release!();
      this.finishReceive();
      return 0;
    };
    if (this.pending === null || !this.streaming) return finish();
    // OnRenderStart records the sums before reading timeGetTime.
    this.timing.recordFrame(this.timing.performanceLate, this.timing.performanceInterval);
    this.timing.renderStartMilliseconds = this.rawClock.rawMilliseconds();
    const fail = (error: unknown): never => {
      this.renderBarrier = null;
      release!();
      this.finishReceive();
      throw error;
    };
    const afterDelivery = (): Promise<number> =>
      burikoMovieThrottle(this.timing.renderEnd(this.rawClock.rawMilliseconds())).then(finish);
    try {
      // 1225a0 ignores the HRESULT, but the real callback completes under the render lock.
      const delivered = this.renderer.deliver(this.pending);
      return typeof delivered === 'number'
        ? afterDelivery().catch(fail)
        : delivered.then(afterDelivery).catch(fail);
    } catch (error) {
      return fail(error);
    }
  }

  private finishReceive(): void {
    this.receiveBarrier = null;
    const finish = this.endReceive;
    this.endReceive = null;
    finish?.();
  }

  private finishError(result: number): number {
    if (
      (result | 0) < 0 &&
      this.state !== 0 &&
      !this.flushing &&
      !this.aborted &&
      !this.runtimeError
    ) {
      this.graphEvents.notify(this, 3, BigInt(result | 0));
      if (this.streaming && !this.endOfStreamDelivered) this.notifyEndOfStream();
      this.runtimeError = true;
    }
    return result;
  }

  beginFlush(): number | Promise<number> {
    return this.withRenderLock(() => {
      this.flushing = true;
      if (this.state === 1) this.events.setReady(false);
      this.events.setAbort(false);
      this.events.cancelNotification();
      this.pending = null;
      const barrier = this.receiveBarrier;
      const finish = (): number => {
        this.clearEndOfStream();
        return 0;
      };
      return barrier === null ? finish() : barrier.then(finish);
    });
  }

  endFlush(): number | Promise<number> {
    return this.withRenderLock(() => {
      this.clearMediaPosition();
      this.events.setAbort(true);
      this.flushing = false;
      this.runtimeError = false;
      return 0;
    });
  }

  endOfStream(): number | Promise<number> {
    return this.withRenderLock(() => {
      if (this.state === 0) return 0x80040227;
      if (this.flushing) return 1;
      if (this.runtimeError) return 0x8004020b;
      this.endOfStreamSeen = true;
      if (this.pending === null) {
        this.events.setReady(true);
        if (this.streaming) this.sendEndOfStream();
      }
      return 0;
    });
  }

  private clearMediaPosition(): void {
    this.mediaStart = this.mediaEnd = 0n;
    this.mediaPositionValid = false;
  }
  private cancelEndTimer(): void {
    if (this.endTimer !== null) clearTimeout(this.endTimer);
    this.endTimer = null;
  }
  private clearEndOfStream(): void {
    this.cancelEndTimer();
    this.endOfStreamSeen = this.endOfStreamDelivered = false;
    this.sampleEnd = 0n;
  }
  private sendEndOfStream(): void {
    if (!this.endOfStreamSeen || this.endOfStreamDelivered || this.endTimer !== null) return;
    if (this.clock !== null) {
      const remaining =
        BigInt.asIntN(64, this.sampleEnd + this.graphStart - this.clock.now()) / 10000n;
      const milliseconds = Number(BigInt.asIntN(32, remaining));
      if (milliseconds > 49) {
        this.endTimer = setTimeout(() => {
          this.endTimer = null;
          this.notifyEndOfStream();
        }, milliseconds);
        return;
      }
    }
    this.notifyEndOfStream();
  }
  private notifyEndOfStream(): void {
    if (!this.streaming || this.disposed) return;
    this.endTimer = null;
    if (this.mediaPositionValid)
      this.mediaStart = this.mediaEnd = BigInt.asIntN(64, this.sourceStopPosition);
    this.endOfStreamDelivered = true;
    this.graphEvents.notify(this, 1);
  }

  getState(
    milliseconds: number,
  ): {status: number; state: 0 | 1 | 2} | Promise<{status: number; state: 0 | 1 | 2}> {
    const waited = this.events.waitForState(milliseconds);
    return typeof waited === 'number'
      ? {status: waited, state: this.state}
      : waited.then((status) => ({status, state: this.state}));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.state = 0;
    this.streaming = false;
    this.pending = null;
    this.cancelEndTimer();
    this.events.dispose();
    this.graphEvents.removeRenderer(this);
    this.connected = false;
  }
}
