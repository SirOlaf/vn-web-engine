/** Browser CreateMutexA cannot establish a named kernel object across processes. */
export class BrowserWindowsNamedMutexHost {
  createOwned(_name: {readonly bytes: Uint8Array; readonly offset: number} | null): null {
    return null;
  }
  release(_handle: unknown): void {}
  close(_handle: unknown): void {}
}
