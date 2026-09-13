import type {AokanaDisplayAdapterProfile} from './display-device.js';
import {AokanaNativeDisplayState, type AokanaNativeRectangle} from './display-state.js';

export interface AokanaAdapterDesktopMode {
  width: number;
  height: number;
  refreshRate: number;
  format: number;
}
export interface AokanaConfiguredDisplayAdapter {
  readonly monitor: number;
  readonly pixelShaderVersion: number;
  /** Exact D3DADAPTER_IDENTIFIER9 bytes when the configured host supplies them. */
  readonly identifier?: Uint8Array;
  /** Current host adapter data, distinct from the last queried display-state cache. */
  readonly mode: AokanaAdapterDesktopMode;
}

/** Concrete configured adapter/monitor profile for the title's D3D9/Win32 query boundary.
 * Monitor rectangles are the same shared list used by B0. Largest intersection wins;
 * configured order breaks equal-area/equal-distance ties that Win32 does not specify.
 * The window-rectangle primitive must retain the restored rectangle while minimized. */
export class AokanaDisplayAdapters implements AokanaDisplayAdapterProfile {
  constructor(
    readonly display: AokanaNativeDisplayState,
    readonly records: readonly AokanaConfiguredDisplayAdapter[],
    readonly primaryMonitor: number,
    readonly readWindowRectangle: () => AokanaNativeRectangle,
  ) {
    if (records.length === 0 || display.monitors[primaryMonitor] === undefined)
      throw new Error('Aokana display requires an explicit configured adapter and primary monitor');
    for (const record of records)
      if (display.monitors[record.monitor] === undefined)
        throw new Error('Aokana adapter references a monitor absent from the shared list');
      else if (record.identifier !== undefined && record.identifier.length !== 0x450)
        throw new RangeError('Aokana adapter identifier requires its native 0x450-byte record');
  }

  /** B2FD0: MonitorFromWindow(flag=geometryChanged ? NEAREST : PRIMARY). */
  currentMonitor(): number {
    const [left, top, right, bottom] = this.readWindowRectangle();
    let selected = -1,
      largest = 0n,
      nearest = this.primaryMonitor,
      distance: bigint | null = null;
    for (let index = 0; index < this.display.monitors.length; index++) {
      const [x0, y0, x1, y1] = this.display.monitors[index]!,
        width = Math.max(0, Math.min(right, x1) - Math.max(left, x0)),
        height = Math.max(0, Math.min(bottom, y1) - Math.max(top, y0)),
        area = BigInt(width) * BigInt(height);
      if (area > largest) {
        largest = area;
        selected = index;
      }
      const dx = BigInt(Math.max(0, left - x1, x0 - right)),
        dy = BigInt(Math.max(0, top - y1, y0 - bottom)),
        squared = dx * dx + dy * dy;
      if (distance === null || squared < distance) {
        nearest = index;
        distance = squared;
      }
    }
    return selected >= 0 ? selected : this.display.geometryChanged !== 0 ? nearest : this.primaryMonitor;
  }

  /** B2F20 reads the current monitor even when displayFlag later selects adapter zero. */
  selectedAdapter(): number {
    const monitor = this.currentMonitor();
    if (this.display.displayFlag !== 1) return 0;
    const selected = this.records.findIndex((record) => record.monitor === monitor);
    return selected < 0 ? 0 : selected;
  }

  get pixelShaderVersion(): number {
    return this.display.pixelShaderVersion >>> 0;
  }
  get refreshRate(): number {
    return this.display.desktopRefreshRate >>> 0;
  }

  /** B2EC0 copies all four DWORDs into either the caller's record or the shared cache. */
  queryDesktopMode(output: AokanaAdapterDesktopMode | null = null): boolean {
    return this.queryAdapterMode(this.selectedAdapter(), output);
  }
  /** Startup queries primary adapter zero directly, bypassing MonitorFromWindow. */
  queryAdapterMode(index: number, output: AokanaAdapterDesktopMode | null = null): boolean {
    const mode = this.records[index >>> 0]?.mode;
    if (mode === undefined) return false;
    if (output !== null) {
      output.width = mode.width >>> 0;
      output.height = mode.height >>> 0;
      output.refreshRate = mode.refreshRate >>> 0;
      output.format = mode.format >>> 0;
    } else {
      this.display.desktopWidth = mode.width >>> 0;
      this.display.desktopHeight = mode.height >>> 0;
      this.display.desktopRefreshRate = mode.refreshRate >>> 0;
      this.display.desktopFormat = mode.format >>> 0;
    }
    return true;
  }

  /** B2C20's caller separately checks whether the D3D9 owner exists. */
  desktopSizeChanged(): boolean {
    const mode = {width: 0, height: 0, refreshRate: 0, format: 0};
    return this.queryDesktopMode(mode) &&
      (mode.width !== (this.display.desktopWidth >>> 0) || mode.height !== (this.display.desktopHeight >>> 0));
  }

  /** B6D60 copies the current monitor origin, independently of the selected adapter. */
  readMonitorOrigin(): readonly [number, number] {
    const rectangle = this.display.monitors[this.currentMonitor()]!;
    this.display.desktopOrigin[0] = rectangle[0] | 0;
    this.display.desktopOrigin[1] = rectangle[1] | 0;
    return this.display.desktopOrigin;
  }
}
