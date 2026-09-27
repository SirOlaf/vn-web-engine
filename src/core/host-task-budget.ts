/** Cooperative main-thread work must return to a host task, not just a microtask. */
export function yieldToHost(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Wall-time budget between safe resumption points. A single step is never preempted. */
export class HostTaskBudget {
  private deadline: number;

  constructor(readonly sliceMilliseconds = 4) {
    if (!Number.isFinite(sliceMilliseconds) || sliceMilliseconds <= 0)
      throw new RangeError('Host task slice must be a positive finite duration');
    this.deadline = performance.now() + sliceMilliseconds;
  }

  reset(): void {
    this.deadline = performance.now() + this.sliceMilliseconds;
  }

  /** Avoid allocating or awaiting a Promise while the current slice has time left. */
  checkpoint(): Promise<void> | undefined {
    if (performance.now() < this.deadline) return undefined;
    return yieldToHost().then(() => this.reset());
  }
}
