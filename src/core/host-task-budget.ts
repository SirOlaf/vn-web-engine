/** Cooperative main-thread work must return to a host task, not just a microtask. */
export function yieldToHost(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof MessageChannel === 'undefined') {
      setTimeout(resolve, 0);
      return;
    }
    // Schedule the continuation's timer from a non-timer task. This resets HTML's
    // nesting level, avoiding the 4 ms clamp on repeated cooperative yields while
    // retaining an ordinary timer turn for already queued timers and audio work.
    const task = new MessageChannel();
    task.port1.onmessage = () => {
      task.port1.close();
      task.port2.close();
      setTimeout(resolve, 0);
    };
    task.port2.postMessage(null);
  });
}

/** Wall-time budget between safe resumption points. A single step is never preempted. */
export class HostTaskBudget {
  private deadline: number;
  private checkpointsSinceClock = 0;

  constructor(
    readonly sliceMilliseconds = 4,
    readonly checkpointInterval = 64,
  ) {
    if (!Number.isFinite(sliceMilliseconds) || sliceMilliseconds <= 0)
      throw new RangeError('Host task slice must be a positive finite duration');
    if (!Number.isSafeInteger(checkpointInterval) || checkpointInterval < 1)
      throw new RangeError('Host task checkpoint interval must be a positive safe integer');
    this.deadline = performance.now() + sliceMilliseconds;
  }

  reset(): void {
    this.checkpointsSinceClock = 0;
    this.deadline = performance.now() + this.sliceMilliseconds;
  }

  /** Opt in only after small synchronous steps; check normally after other work. */
  checkpointBatched(): Promise<void> | undefined {
    if (++this.checkpointsSinceClock < this.checkpointInterval) return undefined;
    return this.checkpoint();
  }

  /** Avoid allocating or awaiting a Promise while the current slice has time left. */
  checkpoint(): Promise<void> | undefined {
    if (this.checkpointsSinceClock !== 0) this.checkpointsSinceClock = 0;
    if (performance.now() < this.deadline) return undefined;
    return yieldToHost().then(() => this.reset());
  }
}
