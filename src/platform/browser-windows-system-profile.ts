/** Browser Win32 identity queries fail without inventing account or kernel data. */
export class BrowserWindowsSystemProfileHost {
  readUserName(): Uint8Array | null { return null; }
  readComputerName(): Uint8Array | null { return null; }
  readVersion(): null { return null; }
  readLegacyPhysicalMemory(): null { return null; }
  readPhysicalMemory(): null { return null; }
}
