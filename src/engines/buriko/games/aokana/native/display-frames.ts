import {AokanaDisplayDevice} from './display-device.js';
import {AokanaDisplayManager} from './display-manager.js';
import {AokanaNativeClock} from './clock.js';
import {AokanaSystemTicks} from './system-ticks.js';
import {AokanaFrameMetrics} from './frame-metrics.js';
import {AokanaMovieRegistry} from './movie-registry.js';
import {AokanaFullscreenMovieState} from './movie-fullscreen-state.js';
import {AokanaInlineTextControl} from './inline-text-control.js';
import {AokanaChildWindows} from './child-windows.js';
import type {AokanaBitmapRectangle} from './bitmap.js';

/** Concrete frame preparation/presentation policy around the actual shared runtime owners. */
export class AokanaDisplayFrames {
  private lostSince = 0n; // 27cd08 is an elapsed-clock QWORD, unlike the ordinary DWORD deadline.
  constructor(
    readonly manager: AokanaDisplayManager,
    readonly device: AokanaDisplayDevice,
    readonly clock: AokanaNativeClock,
    readonly ticks: AokanaSystemTicks,
    readonly metrics: AokanaFrameMetrics,
    readonly movies: AokanaMovieRegistry,
    readonly fullscreenMovie: AokanaFullscreenMovieState,
    readonly inline: AokanaInlineTextControl,
    readonly children: AokanaChildWindows,
  ) {}
  get display() {
    return this.manager.displayState;
  }

  /** b62a0 accepts frequency0..1000 and resets the absolute frame deadline. */
  setFrameFrequency(frequency: number): 0 | 1 {
    frequency >>>= 0;
    if (frequency > 1000) return 0;
    this.display.frameInterval = frequency === 0 ? 0 : Math.floor(1000 / frequency);
    this.display.frameDeadline = 0;
    return 1;
  }
  /** b6c60 schedules raw-clock device work; a first nonforced request remains conditional. */
  requestDeviceChange(force: number): void {
    const first = this.display.forcedDeviceChange === 0;
    this.display.forcedDeviceChange = 1;
    this.display.deviceChangePending = 1;
    if (first && (force | 0) === 0) this.display.forcedDeviceChange = 0;
    const delay = Math.floor(6000 / this.device.refreshRate);
    this.display.deviceChangeDeadline = (this.ticks.getTickCount() + 1 + delay) >>> 0;
  }
  /** b6630 sends this EDIT paint synchronously while the shared suppression flag is set. */
  private async paintInline(): Promise<void> {
    const target = this.inline.target;
    if (target === null || this.inline.state.visible === 0) return;
    this.display.inlinePaintSuppression = 1;
    this.inline.messages.invalidate(target);
    const paint = this.inline.messages.takePaint(target);
    let validated = false;
    try {
      if (paint !== null) {
        this.inline.messages.validatePaint(paint);
        validated = true;
        await this.inline.handleMessage(paint);
      }
    } catch (error) {
      if (paint !== null && !validated) this.inline.messages.releasePaint(paint);
      throw error;
    } finally {
      this.display.inlinePaintSuppression = 0;
    }
  }
  /** b7320 deliberately ignores prepare/Present status and returns only the initialized wait count. */
  async present(
    count: number,
    rectangles: readonly AokanaBitmapRectangle[] | null,
    x: number,
    y: number,
  ): Promise<number> {
    this.device.prepare(count, rectangles, x, y);
    const result = {waitCount: 0};
    await this.device.present(result);
    await this.paintInline();
    this.children.invalidateVisible();
    return result.waitCount;
  }
  presentTransient(x: number, y: number): Promise<number> {
    return this.present(1, null, x, y);
  }
  /** b6520 commits metrics before checking draw success, then sweeps finished surface movies. */
  async drawDamage(): Promise<number> {
    this.metrics.begin();
    const result = {count: 0, rectangles: [] as AokanaBitmapRectangle[]};
    const drawn = this.manager.drawDamage(result);
    this.metrics.end(1);
    if (drawn === 0) return 0;
    this.movies.removeFinished(this.manager.surfaces);
    if (result.count === 0 && this.display.continuousPresentation === 0) return 0;
    return result.count !== 0 && result.count !== 0xffffffff
      ? this.present(result.count, result.rectangles, 0, 0)
      : this.present(1, null, 0, 0);
  }
  /** b65e0 has the same measurement/sweep ordering but always presents a successful full draw. */
  async drawFull(): Promise<number> {
    this.metrics.begin();
    const drawn = this.manager.drawFull();
    this.metrics.end(1);
    if (drawn === 0) return 0;
    this.movies.removeFinished(this.manager.surfaces);
    return this.present(1, null, 0, 0);
  }
  /** b6360: one outer-loop display decision, with separate pauseable and raw clock domains. */
  async poll(): Promise<number> {
    let result = -1;
    const status = this.device.cooperativeStatus() >>> 0;
    if (status === 0) {
      if (
        this.fullscreenMovie.presentationFlag === 0 &&
        !this.fullscreenMovie.suppressesOrdinaryDisplay()
      ) {
        const continuous = this.display.continuousPresentation;
        if (
          (this.manager.redraw.pending !== 0 &&
            this.display.presentationEnabled !== 0 &&
            this.display.ordinaryPresentationEnabled !== 0) ||
          continuous !== 0
        ) {
          const now = Number(BigInt.asUintN(32, this.clock.read()));
          if (this.manager.redraw.pending === 0 || now < this.display.frameDeadline >>> 0) {
            if (continuous !== 0) result = await this.present(1, null, 0, 0);
          } else {
            result =
              this.manager.redraw.mode === 0 ? await this.drawDamage() : await this.drawFull();
            this.display.measuredDrawCount = (this.display.measuredDrawCount + 1) >>> 0;
            this.manager.redraw.pending = 0;
            if (this.display.frameInterval !== 0) {
              const deadline = this.display.frameDeadline >>> 0,
                interval = this.display.frameInterval >>> 0;
              this.display.frameDeadline =
                (deadline +
                  Math.imul(
                    Math.floor(((now - deadline) >>> 0) / interval) + 1,
                    this.display.frameInterval,
                  )) >>>
                0;
            }
          }
        }
      }
    } else if (status === 0x80000000) {
      if (this.lostSince === 0n) this.lostSince = BigInt.asUintN(64, this.clock.read());
      if (BigInt.asUintN(64, this.clock.read()) < BigInt.asUintN(64, this.lostSince + 4000n)) {
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        return 1;
      }
      this.requestDeviceChange(1);
    } else {
      if (status !== 0x80000001) return -1;
      if (this.display.presentationEnabled !== 0 && this.display.ordinaryPresentationEnabled !== 0)
        this.display.delayedRedrawDeadline =
          (this.ticks.getTickCount() + 1 + Math.floor(3000 / this.device.refreshRate)) >>> 0;
    }
    this.lostSince = 0n;
    return result;
  }
}
