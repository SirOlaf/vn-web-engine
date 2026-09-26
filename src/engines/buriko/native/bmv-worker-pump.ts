import type {BurikoBmvService} from './bmv-service.js';

/** One accepted BF worker per host task, in the service's native admission order. */
export class BurikoBmvWorkerPump {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<boolean> | null = null;
  private joining: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private closed = false;
  private failure: unknown = null;

  constructor(readonly service: BurikoBmvService) {
    service.bindWorkerReady(() => this.schedule());
  }

  private schedule(): void {
    if (
      this.closed ||
      this.timer !== null ||
      this.running !== null ||
      this.joining !== null ||
      this.failure !== null
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runOne();
    }, 0);
  }

  private runOne(): void {
    if (this.closed || this.running !== null || this.joining !== null) return;
    const work = this.service.processNext();
    this.running = work;
    void work.then(
      () => {
        if (this.running === work) this.running = null;
        if (this.service.hasQueuedWorkers) this.schedule();
      },
      (error: unknown) => {
        if (this.running === work) this.running = null;
        this.failure ??= error;
      },
    );
  }

  /** Join the finite work admitted so far without closing later worker admission. */
  joinAccepted(): Promise<void> {
    if (this.joining !== null) return this.joining;
    if (this.closed) return this.closing ?? Promise.resolve();
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const join = (async () => {
      await this.running;
      while (this.service.hasQueuedWorkers) await this.service.processNext();
      if (this.failure !== null) throw this.failure;
    })();
    this.joining = join;
    void join.then(
      () => {
        if (this.joining === join) this.joining = null;
        if (this.service.hasQueuedWorkers) this.schedule();
      },
      () => {
        if (this.joining === join) this.joining = null;
      },
    );
    return join;
  }

  /** Close admission, join the accepted slice, then drain the finite queued prefix. */
  closeAndDrain(): Promise<void> {
    if (this.closing !== null) return this.closing;
    this.closed = true;
    this.service.closeAdmission();
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.closing = (async () => {
      try {
        await this.joining;
        await this.running;
      } catch (error) {
        this.failure ??= error;
      }
      while (this.service.hasQueuedWorkers) {
        try {
          await this.service.processNext();
        } catch (error) {
          this.failure ??= error;
        }
      }
      if (this.failure !== null) throw this.failure;
    })();
    return this.closing;
  }
}
