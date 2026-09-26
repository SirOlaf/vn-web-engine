/** Explicit synchronous GetDriveType-shaped primitive; mounts do not imply drive types. */
export interface WindowsDriveTypeHost {
  readDriveType(root: string): number;
}

/** Successful GetLogicalDriveStringsW snapshot in the host's actual returned order. */
export interface WindowsLogicalDriveHost extends WindowsDriveTypeHost {
  /** Enumeration failure or size/fill races must reject instead of guessing roots. */
  readLogicalDriveStrings(): readonly string[];
}

/** A browser has no Win32 drive-letter namespace or removable media devices. */
export class BrowserWindowsLogicalDriveHost implements WindowsLogicalDriveHost {
  readLogicalDriveStrings(): readonly string[] { return []; }
  readDriveType(_root: string): number { return 1; }
  readFreeBytesAvailable(_path: string): bigint | null { return null; }
  readBytesPerSector(_root: string): number | null { return null; }
  readVolumeLabel(_root: Uint8Array, _output: unknown, _capacity: number): number { return 0; }
}
