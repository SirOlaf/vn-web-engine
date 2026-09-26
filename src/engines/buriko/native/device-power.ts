import {pointerView, type BurikoBpPointer} from '../bp/memory.js';
import type {BurikoProgramFiles} from './program-files.js';
import type {BurikoSystemProfile} from './system-profile.js';

export interface BurikoDevicePowerHandle {
  readonly burikoDevicePowerHandle: true;
}

/** Explicit synchronous CreateFileW/GetDevicePowerState/CloseHandle boundary. */
export interface BurikoDevicePowerHost {
  openDevice(
    path: string,
    desiredAccess: number,
    shareMode: number,
    creationDisposition: number,
    flagsAndAttributes: number,
  ): BurikoDevicePowerHandle | null;
  queryDevicePowerState(handle: BurikoDevicePowerHandle): number | null;
  closeDevice(handle: BurikoDevicePowerHandle): void;
}

interface ProfileHandle extends BurikoDevicePowerHandle {
  readonly path: string;
}

/** Concrete selected device results; no battery or mounted-file state is inferred. */
export class BurikoDevicePowerProfile implements BurikoDevicePowerHost {
  private readonly devices = new Map<string, number | null>();
  private readonly live = new Map<ProfileHandle, number | null>();

  constructor(entries: Iterable<readonly [string, number | null]>) {
    for (const [path, powered] of entries)
      this.devices.set(path, powered === null ? null : powered >>> 0);
  }

  openDevice(
    path: string,
    desiredAccess: number,
    shareMode: number,
    creationDisposition: number,
    flagsAndAttributes: number,
  ): BurikoDevicePowerHandle | null {
    if (
      desiredAccess !== 0x80000000 ||
      shareMode !== 1 ||
      creationDisposition !== 3 ||
      flagsAndAttributes !== 0x80
    )
      throw new RangeError('Buriko device-power profile requires the native CreateFileW contract');
    if (!this.devices.has(path)) return null;
    const handle: ProfileHandle = {burikoDevicePowerHandle: true, path};
    this.live.set(handle, this.devices.get(path)!);
    return handle;
  }

  queryDevicePowerState(handle: BurikoDevicePowerHandle): number | null {
    return this.live.get(handle as ProfileHandle) ?? null;
  }

  closeDevice(handle: BurikoDevicePowerHandle): void {
    this.live.delete(handle as ProfileHandle);
  }
}

export class BurikoDevicePower {
  constructor(
    readonly system: BurikoSystemProfile,
    readonly files: BurikoProgramFiles,
    readonly host: BurikoDevicePowerHost,
  ) {}

  /** BCB20 reports the open result; a failed power query after open still returns one. */
  read(output: BurikoBpPointer | null, path: BurikoBpPointer): number {
    const version = this.system.readVersionRecord();
    if (
      new DataView(version.buffer, version.byteOffset, version.byteLength).getUint32(16, true) !== 2
    )
      return 1;
    const widePath = this.files.text.decodeAuto(path);
    const handle = this.host.openDevice(widePath, 0x80000000, 1, 3, 0x80);
    if (handle === null) return 0;
    try {
      const powered = this.host.queryDevicePowerState(handle);
      if (powered !== null && output !== null) pointerView(output, 4).setUint32(0, powered, true);
    } finally {
      this.host.closeDevice(handle);
    }
    return 1;
  }
}
