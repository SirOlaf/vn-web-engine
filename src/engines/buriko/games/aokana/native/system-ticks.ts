/**
 * Raw Win32 DWORD clock boundary, independent of BGI's pause/gap-adjusted clock.
 * The browser profile uses elapsed monotonic milliseconds from the supplied
 * performance time origin for both native APIs. No BGI suspension is applied.
 */
export class AokanaSystemTicks {
  constructor(private readonly performance: Pick<Performance, 'now'>) {}

  timeGetTime(): number {
    return Math.trunc(this.performance.now()) >>> 0;
  }

  getTickCount(): number {
    return Math.trunc(this.performance.now()) >>> 0;
  }
}
