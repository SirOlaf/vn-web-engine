import {FileError} from '../../../platform/filesystem.js';
import {launchWindowsProcess, type WindowsProcessHost} from '../../../platform/windows-process.js';
import {copyMemoryBytes} from '../../../core/indeterminate-memory.js';
import type {BurikoBpPointer} from '../bp/memory.js';
import type {BurikoProgramFiles} from './program-files.js';

const comapName = new TextEncoder().encode('comap.dat\0');
const comapMagic = 0x21a0bb7f;
const comapBytes = 0x404;

function dword(bytes: Uint8Array, offset: number, label: string): number {
  if (offset < 0 || offset + 4 > bytes.length)
    throw new Error(`Buriko 1.69 registration consumes unwritten ${label}`);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

const registrationTool = new Uint16Array([0x72, 0x65, 0x67, 0x2e, 0x65, 0x78, 0x65, 0]);

/** 422a20/422ab0 and 422b10: the 1.69 COMAP registration probe and its WinExec retry. */
export class BurikoLegacy169Registration {
  constructor(
    readonly files: BurikoProgramFiles,
    private readonly readBaseIdentity: () => number,
    readonly processHost: WindowsProcessHost | null,
  ) {}

  /** 422710 is the unsalted sibling of 4228a0. */
  baseIdentity(): number {
    return this.readBaseIdentity() >>> 0;
  }

  private async openComap(
    output: BurikoBpPointer | null = null,
  ): Promise<{bytes: Uint8Array; readLength: number} | null> {
    const opened = await this.files.open(comapName);
    if (opened.source === null) return null;
    try {
      const bytes = await opened.source.read(0, Math.min(opened.source.size, comapBytes));
      if (output !== null && bytes.length !== 0)
        copyMemoryBytes(output.bytes, output.offset, bytes, 0, bytes.length);
      return {bytes, readLength: bytes.length};
    } catch (error) {
      if (error instanceof FileError || error instanceof DOMException)
        return {bytes: new Uint8Array(), readLength: 0};
      throw error;
    }
  }

  /** 422b10 returns CreateFileA success; its subsequent 0x404-byte ReadFile result is ignored. */
  async loadComap(output: BurikoBpPointer | null): Promise<boolean> {
    return (await this.openComap(output)) !== null;
  }

  /** 422a20 checks the COMAP header, indexed value, salt, and unsalted machine identity. */
  async registered(): Promise<boolean> {
    const file = await this.openComap();
    if (file === null) return false;
    if (file.readLength < 4)
      throw new Error('Buriko 1.69 registration reads an unwritten COMAP header');
    if (dword(file.bytes, 0, 'COMAP header') !== comapMagic) return false;
    const index = dword(file.bytes, 0x128, 'COMAP index');
    const entryOffset = 4 + index * 4;
    if (!Number.isSafeInteger(entryOffset) || entryOffset + 4 > comapBytes)
      throw new Error('Buriko 1.69 registration indexes beyond its native COMAP stack buffer');
    const identity = this.baseIdentity();
    return (
      (dword(file.bytes, entryOffset, 'COMAP table entry') ^
        dword(file.bytes, 0x100, 'COMAP salt')) >>>
        0 ===
      identity
    );
  }

  private async launchRegistrationTool(): Promise<void> {
    const host = this.processHost;
    if (host === null) return;
    await launchWindowsProcess(host, registrationTool, 1);
  }

  /** 422ab0 launches reg.exe once, waits, then performs ten more one-second probes. */
  async check(): Promise<boolean> {
    if (await this.registered()) return true;
    const host = this.processHost;
    if (host === null) return false;
    await this.launchRegistrationTool();
    await host.sleep(1000);
    for (let attempt = 0; attempt < 10; attempt++) {
      await host.sleep(1000);
      if (await this.registered()) return true;
    }
    return false;
  }
}
