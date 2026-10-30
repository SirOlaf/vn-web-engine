/** Browser Win32 identity queries fail without inventing account or kernel data. */
export class BrowserWindowsSystemProfileHost {
  readUserName(): Uint8Array | null { return null; }
  readComputerName(): Uint8Array | null { return null; }
  readVersion(): null { return null; }
  readLegacyPhysicalMemory(): null { return null; }
  readPhysicalMemory(): null { return null; }
  /** CRT `getenv`: the page has no process environment, so no variable is set. */
  readEnvironmentVariable(_name: Uint8Array): Uint8Array | null { return null; }
}
