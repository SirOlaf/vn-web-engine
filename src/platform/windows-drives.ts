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
  readLogicalDriveStrings(): readonly string[] {
    return [];
  }
  readDriveType(_root: string): number {
    return 1;
  }
  checkDeviceMedia(_root: string): boolean | null {
    return null;
  }
  hasVolume(_root: string): boolean {
    return false;
  }
  readFreeBytesAvailable(_path: string): bigint | null {
    return null;
  }
  readBytesPerSector(_root: string): number | null {
    return null;
  }
  readVolumeLabel(_root: Uint8Array, _output: unknown, _capacity: number): number {
    return 0;
  }
}

/** Removable-media presence for one drive root, queried at each use. */
export interface WindowsDriveMediaHost {
  /** IOCTL_STORAGE_CHECK_VERIFY2 on `\\.\X:`; null when the device cannot be opened. */
  checkDeviceMedia(root: string): boolean | null;
  /** GetVolumeInformationW on the root under SEM_FAILCRITICALERRORS. */
  hasVolume(root: string): boolean;
}

export function isWindowsDriveMediaHost(host: object): host is WindowsDriveMediaHost {
  const candidate = host as Partial<WindowsDriveMediaHost>;
  return (
    typeof candidate.checkDeviceMedia === 'function' && typeof candidate.hasVolume === 'function'
  );
}

/** A drive presented by the project, such as a selected disc folder shown as an optical drive. */
export interface WindowsPresentedDrive {
  /** `X:\` */
  readonly root: string;
  /** GetDriveType result: 2 removable, 3 fixed, 5 CD-ROM. */
  readonly type: 2 | 3 | 5;
  /** Inserted media for removable and CD-ROM drives; fixed drives always have a volume. */
  readonly mediaPresent: boolean;
}

/** Explicit drive letters chosen by the host; unlisted letters do not exist. Volume labels,
 * free space and sector geometry stay unavailable unless a host can supply real values. */
export class PresentedWindowsLogicalDriveHost
  implements WindowsLogicalDriveHost, WindowsDriveMediaHost
{
  private readonly drives: readonly WindowsPresentedDrive[];

  constructor(drives: readonly WindowsPresentedDrive[]) {
    const seen = new Set<string>();
    for (const drive of drives) {
      if (!/^[A-Z]:\\$/.test(drive.root))
        throw new RangeError('Presented drive roots must be upper-case X:\\ roots');
      if (seen.has(drive.root)) throw new RangeError(`Duplicate presented drive ${drive.root}`);
      seen.add(drive.root);
    }
    this.drives = [...drives].sort((left, right) => left.root.localeCompare(right.root));
  }

  private drive(root: string): WindowsPresentedDrive | undefined {
    const letter = /^([A-Za-z]):\\?$/.exec(root)?.[1]?.toUpperCase();
    return letter === undefined ? undefined : this.drives.find((d) => d.root[0] === letter);
  }

  readLogicalDriveStrings(): readonly string[] {
    return this.drives.map((drive) => drive.root);
  }
  readDriveType(root: string): number {
    return this.drive(root)?.type ?? 1;
  }
  checkDeviceMedia(root: string): boolean | null {
    const drive = this.drive(root);
    return drive === undefined ? null : drive.type === 3 || drive.mediaPresent;
  }
  hasVolume(root: string): boolean {
    const drive = this.drive(root);
    return drive !== undefined && (drive.type === 3 || drive.mediaPresent);
  }
  readFreeBytesAvailable(_path: string): bigint | null {
    return null;
  }
  readBytesPerSector(_root: string): number | null {
    return null;
  }
  readVolumeLabel(_root: Uint8Array, _output: unknown, _capacity: number): number {
    return 0;
  }
}
