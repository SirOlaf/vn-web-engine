import type {AokanaNativeClock} from './clock.js';
import {AokanaRainDisplays} from './rain-displays.js';

/** The main loop's simulation and frame-refresh passes are separate native operations. */
export class AokanaRainFrames {
  constructor(
    readonly rain: AokanaRainDisplays,
    private readonly clock: AokanaNativeClock,
  ) {}

  /** 081c20 updates every existing slot, independent of visibility and the global draw gate. */
  updateAll(): void {
    for (let slot = 0; slot < 8; slot++) this.rain.find(0xc1000000 + slot)?.updateRain();
  }

  /** 081bc0 refreshes every existing slot and reports whether any refresh returned success. */
  refreshAll(): 0 | 1 {
    let refreshed: 0 | 1 = 0;
    for (let slot = 0; slot < 8; slot++) {
      const object = this.rain.find(0xc1000000 + slot);
      if (object !== null && object.refreshRain() === 0) refreshed = 1;
    }
    return refreshed;
  }

  /** 0f3d10 refreshes once when due, then advances the absolute DWORD deadline past now. */
  pollRefresh(): void {
    const state = this.rain.state;
    if (state.enabled === 0) return;
    const now = Number(BigInt.asUintN(32, this.clock.read()));
    if (now < state.accumulatedMilliseconds >>> 0) return;
    if (this.refreshAll() !== 0) this.rain.manager.redraw.request(0);
    const deadline = state.accumulatedMilliseconds >>> 0,
      interval = state.frameInterval >>> 0;
    if (interval === 0) throw new RangeError('Aokana rain frame deadline division by zero');
    state.accumulatedMilliseconds =
      (deadline +
        Math.imul(Math.trunc(((now - deadline) >>> 0) / interval) + 1, state.frameInterval)) >>>
      0;
  }
}
