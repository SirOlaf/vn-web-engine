import type {WindowsDisplayEnumerationHost} from '../../../platform/windows-display-enumeration.js';
import type {BurikoNativeClock} from './clock.js';
import type {BurikoNativeDisplayState} from './display-state.js';
import type {BurikoDisplayFrames} from './display-frames.js';
import type {BurikoNativeGamepads} from './gamepads.js';

/** WM_DEVICECHANGE's delayed monitor/DirectInput refresh and ECB90 C5900 poll. */
export class BurikoDeviceEnumerationRefresh {
  private deadline = 0n;

  constructor(
    readonly clock: BurikoNativeClock,
    readonly display: BurikoNativeDisplayState,
    readonly frames: BurikoDisplayFrames,
    readonly gamepads: BurikoNativeGamepads | null,
    readonly host: WindowsDisplayEnumerationHost,
  ) {
    if (frames.display !== display)
      throw new Error('Buriko device enumeration requires shared display and frame owners');
  }

  /** 1400C5970 defers re-enumeration 500 elapsed milliseconds. */
  schedule(): void {
    this.deadline = BigInt.asUintN(64, this.clock.read() + 500n);
  }

  /** C59A0 returns the enumerated count; B2FB0 reads the D3D adapter count. */
  poll(): void {
    const deadline = this.deadline;
    if (deadline === 0n || BigInt.asUintN(64, this.clock.read()) < deadline) return;
    this.gamepads?.refresh();
    const monitors = this.host.enumerateMonitors();
    this.display.monitors = monitors.map((rectangle) => [...rectangle] as typeof rectangle);
    if (monitors.length !== this.host.adapterCount() >>> 0) this.frames.requestDeviceChange(1);
    this.deadline = 0n;
  }
}
