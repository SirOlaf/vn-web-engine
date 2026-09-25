/** A monitor rectangle in desktop pixel coordinates. */
export type WindowsMonitorRectangle = readonly [number, number, number, number];

/** Synchronous snapshot used when a Windows display-change notification is delivered. */
export interface WindowsDisplayEnumerationHost {
  enumerateMonitors(): readonly WindowsMonitorRectangle[];
  adapterCount(): number;
}

/** The browser profile retains the configured display topology until a host replaces it. */
export class BrowserWindowsDisplayEnumerationHost implements WindowsDisplayEnumerationHost {
  constructor(
    private readonly monitors: readonly WindowsMonitorRectangle[],
    private readonly adapters: number,
  ) {}

  enumerateMonitors(): readonly WindowsMonitorRectangle[] {
    return this.monitors.map((rectangle) => [...rectangle] as WindowsMonitorRectangle);
  }

  adapterCount(): number {
    return this.adapters;
  }
}
