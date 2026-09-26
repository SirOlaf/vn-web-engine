/** Bytecode ABI, selected from engine metadata rather than an installation title. */
export interface BurikoBpAbi {
  readonly revision: '1.520.6' | '1.665' | '1.685.3';
  readonly compatibility: '1.69' | '1.72';
  readonly addressBits: 26 | 28;
  readonly addressMask: number;
  readonly moduleTag: number;
  readonly frameTag: number;
  readonly heapTag: number;
  readonly indirectHandles: boolean;
}

/** 1.520.6: resolver004638b0, pointer constructors00450540/00450580. */
export const BURIKO_BP_ABI_169: BurikoBpAbi = Object.freeze({
  revision: '1.520.6',
  compatibility: '1.69',
  addressBits: 26,
  addressMask: 0x03ffffff,
  moduleTag: 0x04000000,
  frameTag: 0x08000000,
  heapTag: 0x0c000000,
  indirectHandles: false,
});

/** 1.665: resolver0049c610 retains 26-bit offsets; grouped pools0049c4b0/0049c560. */
export const BURIKO_BP_ABI_1665: BurikoBpAbi = Object.freeze({
  revision: '1.665',
  compatibility: '1.72',
  addressBits: 26,
  addressMask: 0x03ffffff,
  moduleTag: 0x04000000,
  frameTag: 0x08000000,
  heapTag: 0x0c000000,
  indirectHandles: false,
});

/** 1.685.3: the existing reference's 28-bit offsets and indirect buffer banks. */
export const BURIKO_BP_ABI_172: BurikoBpAbi = Object.freeze({
  revision: '1.685.3',
  compatibility: '1.72',
  addressBits: 28,
  addressMask: 0x0fffffff,
  moduleTag: 0x10000000,
  frameTag: 0x20000000,
  heapTag: 0x30000000,
  indirectHandles: true,
});
