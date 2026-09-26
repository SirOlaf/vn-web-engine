import {AokanaWindowMessages, type AokanaWindowTarget} from './window-messages.js';

export interface AokanaMovieFilterEvent {
  readonly code: number;
  readonly value1: bigint;
  readonly value2: bigint;
}

/** The browser FilterGraph profile's renderer completion and IMediaEvent queue. */
export class AokanaMovieFilterEvents {
  private readonly renderers = new Set<object>();
  private readonly completed = new Set<object>();
  private readonly events: AokanaMovieFilterEvent[] = [];
  private target: AokanaWindowTarget | null = null;
  private message = 0;
  private instance = 0n;
  private disposed = false;
  private readonly observers = new Set<() => void>();
  constructor(readonly messages: AokanaWindowMessages) {}

  /** Host readiness observation; the actual event FIFO remains authoritative. */
  onAvailable(observer: () => void): () => void {
    if (this.disposed) throw new Error('Aokana movie observes a released event queue');
    this.observers.add(observer);
    if (this.events.length !== 0) this.observe(observer);
    return () => {
      this.observers.delete(observer);
    };
  }
  private observe(observer: () => void): void {
    try {
      observer();
    } catch {
      /* Observation cannot change native publication. */
    }
  }
  addRenderer(renderer: object): void {
    if (this.disposed) throw new Error('Aokana movie adds a renderer to a released graph');
    this.renderers.add(renderer);
  }
  removeRenderer(renderer: object): void {
    this.renderers.delete(renderer);
    this.completed.delete(renderer);
  }
  resetCompletion(): void {
    this.completed.clear();
  }

  /** EC_COMPLETE is delivered once all connected renderers have completed. */
  notify(renderer: object, code: number, value1 = 0n, value2 = 0n): void {
    if (this.disposed) return;
    code |= 0;
    if (code === 1) {
      if (!this.renderers.has(renderer) || this.completed.has(renderer)) return;
      this.completed.add(renderer);
      if (this.completed.size !== this.renderers.size) return;
      value1 = 0n;
      value2 = 0n;
    }
    this.events.push({code, value1: BigInt.asIntN(64, value1), value2: BigInt.asIntN(64, value2)});
    if (this.target !== null && this.messages.hasTarget(this.target)) {
      this.messages.post({
        target: this.target,
        message: this.message,
        wParam: 0n,
        lParam: this.instance,
      });
    }
    // Preserve native FIFO/PostMessage publication before any host observer.
    for (const observer of [...this.observers]) this.observe(observer);
  }

  setNotifyWindow(
    target: AokanaWindowTarget | null,
    message: number,
    instance: bigint,
  ): 0 | 0x80070057 {
    if (target !== null && !this.messages.hasTarget(target)) return 0x80070057;
    this.target = target;
    this.message = message >>> 0;
    this.instance = BigInt.asIntN(64, instance);
    return 0;
  }

  take(): AokanaMovieFilterEvent | null {
    return this.events.shift() ?? null;
  }
  dispose(): void {
    this.disposed = true;
    this.target = null;
    this.events.length = 0;
    this.renderers.clear();
    this.completed.clear();
    this.observers.clear();
  }
}
