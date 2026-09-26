/** Synchronous CreateFileMappingA/MapViewOfFile boundary for a named byte mapping. */
export interface WindowsNamedFileMappingHost {
  /** Returns a copy of exactly length bytes, or null if the mapping cannot be opened. */
  read(name: string, length: number): Uint8Array | null;
}

/** Same-origin browser bridge. An embedding application may publish bytes before
 * delivering its corresponding window message; no cross-process OS object is inferred. */
export class BrowserWindowsNamedFileMappingHost implements WindowsNamedFileMappingHost {
  private readonly mappings = new Map<string, Uint8Array>();

  publish(name: string, bytes: Uint8Array): void {
    this.mappings.set(name, bytes.slice());
  }

  remove(name: string): void {
    this.mappings.delete(name);
  }

  read(name: string, length: number): Uint8Array | null {
    if (!Number.isSafeInteger(length) || length < 0) return null;
    const bytes = this.mappings.get(name);
    return bytes !== undefined && bytes.length >= length ? bytes.slice(0, length) : null;
  }
}
