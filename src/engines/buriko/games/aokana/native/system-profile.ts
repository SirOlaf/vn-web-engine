/** Raw ANSI bytes are supplied by the selected Windows host profile, without a terminator. */
export interface AokanaWindowsVersion {
  major: number;
  minor: number;
  build: number;
  platform: number;
  servicePack: Uint8Array;
}
export interface AokanaPhysicalMemoryStatus {
  total: bigint;
  available: bigint;
}
/**
 * Explicit Win32 primitive results. Browser identity and navigator memory estimates do
 * not supply these fields. Names use the host ANSI page, independent of VM text mode.
 * Null represents an unsuccessful API query with no output writes.
 */
export interface AokanaSystemProfileHost {
  readUserName(): Uint8Array | null;
  readComputerName(): Uint8Array | null;
  readVersion(): AokanaWindowsVersion | null;
  readLegacyPhysicalMemory(): AokanaPhysicalMemoryStatus | null;
  readPhysicalMemory(): AokanaPhysicalMemoryStatus | null;
}

function ansiResult(bytes: Uint8Array | null, capacity: number): Uint8Array | null {
  if (bytes === null) return null;
  if (bytes.length >= capacity || bytes.includes(0))
    throw new RangeError('Aokana system host returned an invalid ANSI profile field');
  const output = new Uint8Array(bytes.length + 1);
  output.set(bytes);
  return output;
}

/** C67C0's single lazy OSVERSIONINFOA cache is shared by every native system consumer. */
export class AokanaSystemProfile {
  private initializedVersion = false;
  private readonly versionRecord = new Uint8Array(148);

  constructor(readonly host: AokanaSystemProfileHost) {}

  /** EC710/EC6E0 use fixed capacities of 257 and 16, respectively. */
  userName(): Uint8Array | null {
    return ansiResult(this.host.readUserName(), 257);
  }
  computerName(): Uint8Array | null {
    return ansiResult(this.host.readComputerName(), 16);
  }

  /** A failed first API query still clears the native initialization flag. */
  readVersionRecord(): Uint8Array {
    if (!this.initializedVersion) {
      this.versionRecord.fill(0);
      const view = new DataView(this.versionRecord.buffer);
      view.setUint32(0, 148, true);
      const version = this.host.readVersion();
      if (version !== null) {
        view.setUint32(4, version.major, true);
        view.setUint32(8, version.minor, true);
        view.setUint32(12, version.build, true);
        view.setUint32(16, version.platform, true);
        this.versionRecord.set(ansiResult(version.servicePack, 128)!, 20);
      }
      this.initializedVersion = true;
    }
    // The native helper copies all 148 bytes to its caller before that caller writes outputs.
    return this.versionRecord.slice();
  }

  /** EA070 clamps each unsigned SIZE_T independently before pushing total then available. */
  readLegacyMemory(): [number, number] {
    const status = this.host.readLegacyPhysicalMemory();
    const clamp = (value: bigint): number => {
      const bytes = BigInt.asUintN(64, value);
      return bytes < 0x80000000n ? Number(bytes) : 0x7fffffff;
    };
    return [clamp(status?.total ?? 0n), clamp(status?.available ?? 0n)];
  }

  /** EC560 uses logical shifts of unsigned64 byte counts, then stores their low DWORDs. */
  readMemoryMegabytes(): [number, number] {
    const status = this.host.readPhysicalMemory();
    const megabytes = (value: bigint): number =>
      Number(BigInt.asUintN(32, BigInt.asUintN(64, value) >> 20n));
    return [megabytes(status?.total ?? 0n), megabytes(status?.available ?? 0n)];
  }
}
