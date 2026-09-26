export interface BurikoMovieGraphClock {
  now(): bigint;
}

/** The browser profile's graph clock is independent of Buriko's pausable script clock. */
export class BurikoMovieReferenceClock implements BurikoMovieGraphClock {
  constructor(private readonly readMilliseconds: () => number = () => performance.now()) {}
  now(): bigint {
    return BigInt.asIntN(64, BigInt(Math.trunc(this.readMilliseconds() * 10000)));
  }
  rawMilliseconds(): number {
    return Math.trunc(this.readMilliseconds()) >>> 0;
  }
}

interface RenderWaiter {
  resolve: (result: 0 | 0x80040223) => void;
}
interface ReadyWaiter {
  resolve: (result: 0 | 0x40237) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * The three events in this executable's CBaseRenderer: auto-reset render(+80),
 * manual-reset abort(+88), and manual-reset state-ready(+90). Abort has the
 * lowest WaitForMultipleObjects index and wins if both events are signaled.
 */
export class BurikoMovieRenderEvents {
  private render = false;
  private abort = false;
  private ready = true;
  private readonly renderWaiters: RenderWaiter[] = [];
  private readonly readyWaiters = new Set<ReadyWaiter>();
  private notification: ReturnType<typeof setTimeout> | null = null;
  private notificationGeneration = 0;
  private disposed = false;

  get stateReady(): boolean {
    return this.ready;
  }

  setAbort(running: boolean): void {
    this.abort = !running;
    this.wakeRender();
  }

  signalRender(): void {
    if (this.disposed) return;
    this.render = true;
    this.wakeRender();
  }

  private wakeRender(): void {
    if (this.abort) {
      for (const waiter of this.renderWaiters.splice(0)) waiter.resolve(0x80040223);
    } else if (this.render) {
      const waiter = this.renderWaiters.shift();
      if (waiter !== undefined) {
        this.render = false;
        waiter.resolve(0);
      }
    }
  }

  /** 1235b0's 10-second timeout merely retries; it never returns a timeout. */
  waitForRender(): 0 | 0x80040223 | Promise<0 | 0x80040223> {
    if (this.disposed || this.abort) return 0x80040223;
    if (this.render) {
      this.render = false;
      return 0;
    }
    return new Promise((resolve) => this.renderWaiters.push({resolve}));
  }

  setReady(value: boolean): void {
    this.ready = value;
    if (!value) return;
    for (const waiter of this.readyWaiters) {
      if (waiter.timer !== null) clearTimeout(waiter.timer);
      waiter.resolve(0);
    }
    this.readyWaiters.clear();
  }

  /** GetState observes a timeout as VFW_S_STATE_INTERMEDIATE while retaining state. */
  waitForState(milliseconds: number): 0 | 0x40237 | Promise<0 | 0x40237> {
    if (this.ready) return 0;
    milliseconds >>>= 0;
    if (milliseconds === 0) return 0x40237;
    return new Promise((resolve) => {
      const waiter: ReadyWaiter = {resolve, timer: null};
      this.readyWaiters.add(waiter);
      if (milliseconds !== 0xffffffff) {
        const deadline = performance.now() + milliseconds;
        const check = (): void => {
          if (!this.readyWaiters.has(waiter)) return;
          const remaining = deadline - performance.now();
          if (remaining > 0) {
            waiter.timer = setTimeout(check, Math.min(remaining, 0x7fffffff));
          } else {
            this.readyWaiters.delete(waiter);
            waiter.resolve(0x40237);
          }
        };
        waiter.timer = setTimeout(check, Math.min(milliseconds, 0x7fffffff));
      }
    });
  }

  /** The concrete browser clock link, canceled by native CancelNotification. */
  advise(clock: BurikoMovieGraphClock, graphStart: bigint, sampleStart: bigint): void {
    if (this.disposed) throw new Error('Buriko movie advises a released renderer event');
    if (this.notification !== null) throw new Error('Buriko movie overwrites an active clock link');
    const deadline = BigInt.asIntN(64, graphStart + sampleStart);
    const generation = ++this.notificationGeneration;
    const check = (): void => {
      if (generation !== this.notificationGeneration || this.disposed) return;
      const remaining = deadline - clock.now();
      if (remaining > 0n) {
        const delay =
          remaining > 21474836470000n ? 0x7fffffff : Number((remaining + 9999n) / 10000n);
        this.notification = setTimeout(check, delay);
      } else {
        this.notification = null;
        this.signalRender();
      }
    };
    check();
  }

  /** 122de0 cancels a live advise and always clears the auto-reset render event. */
  cancelNotification(): void {
    this.notificationGeneration++;
    if (this.notification !== null) clearTimeout(this.notification);
    this.notification = null;
    this.render = false;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelNotification();
    this.abort = true;
    this.wakeRender();
    this.setReady(true);
  }
}

/** Native ThrottleWait always yields, including Sleep(0). */
export function burikoMovieThrottle(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds >>> 0));
}
