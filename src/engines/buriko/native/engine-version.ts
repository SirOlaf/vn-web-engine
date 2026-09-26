import {
  BURIKO_BP_ABI_169,
  BURIKO_BP_ABI_1665,
  BURIKO_BP_ABI_172,
  type BurikoBpAbi,
} from '../bp/abi.js';

/** Native revision choices recovered from executable code, independent of product identity. */
export interface BurikoEngineVersion {
  readonly interpreterVersion: string;
  readonly compatibilityVersion: string;
  readonly bpAbi: BurikoBpAbi;
  readonly bootOperandCells: number;
  readonly bootModuleBytes: number;
  readonly bootFrameBytes: number;
}

/** 1.520.6: boot 00462c58, child loader 00462f10, thread constructor 00434c40. */
export const BURIKO_ENGINE_1520 = Object.freeze({
  interpreterVersion: '1.520.6',
  compatibilityVersion: '1.69',
  bpAbi: BURIKO_BP_ABI_169,
  bootOperandCells: 0x1000,
  bootModuleBytes: 0x80000,
  bootFrameBytes: 0x40000,
}) satisfies BurikoEngineVersion;

/** 1.665 x86: boot 0049ae20, loader 0044c900, constructor 0044c5c0. */
export const BURIKO_ENGINE_1665 = Object.freeze({
  interpreterVersion: '1.665',
  compatibilityVersion: '1.72',
  bpAbi: BURIKO_BP_ABI_1665,
  bootOperandCells: 0x1000,
  bootModuleBytes: 0x800000,
  bootFrameBytes: 0x400000,
}) satisfies BurikoEngineVersion;

/** Reference 1.685.3: ED170 appends the boot child with these capacities. */
export const BURIKO_ENGINE_1685 = Object.freeze({
  interpreterVersion: '1.685.3',
  compatibilityVersion: '1.72',
  bpAbi: BURIKO_BP_ABI_172,
  bootOperandCells: 0x1000,
  bootModuleBytes: 0x800000,
  bootFrameBytes: 0x400000,
}) satisfies BurikoEngineVersion;

export function burikoEngineVersion(
  interpreterVersion: string | null,
  compatibilityVersion: string | null,
): BurikoEngineVersion {
  for (const version of [BURIKO_ENGINE_1520, BURIKO_ENGINE_1665, BURIKO_ENGINE_1685]) {
    if (
      version.interpreterVersion === interpreterVersion &&
      version.compatibilityVersion === compatibilityVersion
    )
      return version;
  }
  throw new Error(
    `Unsupported BGI interpreter revision ${interpreterVersion ?? '(unknown)'} / compatibility ${compatibilityVersion ?? '(unknown)'}. Its native ABI must be verified before launch.`,
  );
}
