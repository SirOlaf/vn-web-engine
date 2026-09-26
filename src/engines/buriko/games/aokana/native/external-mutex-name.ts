const prefix = new TextEncoder().encode('Uninstaller for ');
const suffix = new TextEncoder().encode(' is executing.');

/** The separate 256-byte ANSI global at 1EAA50, written by C7620 and read by OpenMutexA.
 * The native formatter does not truncate; inputs exceeding this observed storage are rejected
 * before writing so the browser never models an overrun into the next global. */
export class AokanaExternalMutexName {
  readonly capacity = 256;
  private readonly storage = new Uint8Array(this.capacity);

  /** C7620's exact byte format; an embedded NUL terminates the native %s argument. */
  setUninstallerName(name: Uint8Array): void {
    const end = name.indexOf(0);
    const source = end < 0 ? name : name.subarray(0, end);
    const required = prefix.length + source.length + suffix.length + 1;
    if (required > this.capacity)
      throw new RangeError('Aokana uninstaller mutex name exceeds its native global buffer');
    let offset = 0;
    this.storage.set(prefix, offset);
    offset += prefix.length;
    this.storage.set(source, offset);
    offset += source.length;
    this.storage.set(suffix, offset);
    offset += suffix.length;
    this.storage[offset] = 0;
  }

  /** Snapshot the current NUL-terminated bytes for one synchronous OpenMutexA attempt. */
  readAnsiName(): Uint8Array {
    const end = this.storage.indexOf(0);
    return this.storage.slice(0, end < 0 ? this.capacity : end + 1);
  }
}
