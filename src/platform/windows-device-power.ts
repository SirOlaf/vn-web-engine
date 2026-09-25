/** Browser CreateFileW cannot open a Win32 device to query its power state. */
export class BrowserWindowsDevicePowerHost {
  openDevice(
    _path: string,
    _access: number,
    _sharing: number,
    _disposition: number,
    _attributes: number,
  ): null { return null; }
  queryDevicePowerState(_handle: unknown): null { return null; }
  closeDevice(_handle: unknown): void {}
}
