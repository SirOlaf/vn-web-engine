import type {BurikoNativeClock} from './clock.js';
import {normalizeBurikoAsciiSpaces} from './byte-string-spaces.js';

/** CPUID register order is EAX, EBX, ECX, EDX, as stored by 0c65c0. */
export type BurikoCpuRegisters = readonly [number, number, number, number];
export interface BurikoLogicalProcessorInformation {
  relationship: number;
  processorMask: bigint;
}

/**
 * Explicit Windows-compatible CPU primitives. Browser identity and a numerical
 * instruction profile do not imply CPUID data, processor topology, or a TSC.
 */
export interface BurikoCpuHost {
  cpuid(leaf: number, subleaf: number): BurikoCpuRegisters;
  readTimestampCounter(): bigint;
  setCurrentThreadAffinity(mask: bigint): bigint;
  logicalProcessorCount(): number;
  logicalProcessorInformation(): Iterable<BurikoLogicalProcessorInformation>;
}

const descriptors: Readonly<Record<number, readonly [number, number]>> = {
  0x0a: [5, 0x20020008],
  0x0c: [5, 0x20040010],
  0x0d: [5, 0x40040010],
  0x0e: [5, 0x40060018],
  0x21: [6, 0x40080100],
  0x22: [7, 0x40040200],
  0x23: [7, 0x40080400],
  0x25: [7, 0x40080800],
  0x29: [7, 0x40081000],
  0x2c: [5, 0x40080020],
  0x41: [6, 0x20040080],
  0x42: [6, 0x20040100],
  0x43: [6, 0x20040200],
  0x44: [6, 0x20040400],
  0x45: [6, 0x20040800],
  0x46: [7, 0x40041000],
  0x47: [7, 0x40082000],
  0x48: [6, 0x400c0c00],
  0x4a: [7, 0x400c1800],
  0x4b: [7, 0x40102000],
  0x4c: [7, 0x400c3000],
  0x4d: [7, 0x40104000],
  0x4e: [6, 0x40181800],
  0x60: [5, 0x40080010],
  0x66: [5, 0x40040008],
  0x67: [5, 0x40040010],
  0x68: [5, 0x40040020],
  0x78: [6, 0x40040400],
  0x79: [6, 0x40080080],
  0x7a: [6, 0x40080100],
  0x7b: [6, 0x40080200],
  0x7c: [6, 0x40080400],
  0x7d: [6, 0x40080800],
  0x7f: [6, 0x40020200],
  0x80: [6, 0x40080200],
  0x81: [6, 0x20080080],
  0x82: [6, 0x20080100],
  0x83: [6, 0x20080200],
  0x84: [6, 0x20080400],
  0x85: [6, 0x20080800],
  0x86: [6, 0x40040200],
  0x87: [6, 0x40080400],
  0xd0: [7, 0x40040200],
  0xd1: [7, 0x40040400],
  0xd2: [7, 0x40040800],
  0xd6: [7, 0x40080400],
  0xd7: [7, 0x40080800],
  0xd8: [7, 0x40081000],
  0xdc: [7, 0x400c0600],
  0xdd: [7, 0x400c0c00],
  0xde: [7, 0x400c1800],
  0xe2: [7, 0x40100800],
  0xe3: [7, 0x40101000],
  0xe4: [7, 0x40102000],
  0xea: [7, 0x40183000],
  0xeb: [7, 0x40184800],
  0xec: [7, 0x40186000],
};

function registerBytes(registers: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(registers.length * 4),
    view = new DataView(bytes.buffer);
  for (let i = 0; i < registers.length; i++) view.setUint32(i * 4, registers[i]!, true);
  return bytes;
}

/** Shared 64-byte global at 1e8b80; initialization is explicit, matching 0c6640(null,...). */
export class BurikoCpuProfile {
  private readonly record = new Uint32Array(16);

  constructor(
    readonly host: BurikoCpuHost,
    readonly clock: BurikoNativeClock,
  ) {}

  /** 0c65c0 leaves the destination unchanged when the requested leaf is unsupported. */
  query(leaf: number, subleaf: number = 0): BurikoCpuRegisters | null {
    leaf >>>= 0;
    subleaf >>>= 0;
    const maximum = this.host.cpuid(leaf < 0x80000000 ? 0 : 0x80000000, 0)[0] >>> 0;
    if (maximum < leaf) return null;
    const values = this.host.cpuid(leaf, subleaf);
    return [values[0] >>> 0, values[1] >>> 0, values[2] >>> 0, values[3] >>> 0];
  }

  /** 0c6640 exports indices 0 through 9 even though initialization also writes index 10. */
  read(index: number): number {
    index >>>= 0;
    if (index >= 10)
      throw new RangeError('Buriko CPU record index is outside the indexed-read contract');
    return this.record[index]!;
  }

  /** Full 0c6640 pointer contract, including initialization through a null output. */
  queryRecord(destination: DataView | null, index: number = 0): boolean {
    if (destination === null) return this.initialize();
    index >>>= 0;
    if (index >= 10) return false;
    destination.setUint32(0, this.record[index]!, true);
    return true;
  }

  /** 0ea140 copies all four native 16-byte blocks, including the untouched tail. */
  copyRecord(destination: DataView): void {
    for (let i = 0; i < 16; i++) destination.setUint32(i * 4, this.record[i]!, true);
  }

  /** 0c6250 stops at the first processor-core record and counts its 64-bit mask. */
  firstCoreLogicalProcessorCount(): number {
    for (const information of this.host.logicalProcessorInformation()) {
      if (information.relationship >>> 0 !== 0) continue;
      let mask = BigInt.asUintN(64, information.processorMask),
        count = 0;
      while (mask !== 0n) {
        count += Number(mask & 1n);
        mask >>= 1n;
      }
      return count;
    }
    return 0;
  }

  /** 0c63c0 serializes with CPUID leaf zero before reading the timestamp counter. */
  readTimestampCounter(): bigint {
    this.host.cpuid(0, 0);
    return BigInt.asUintN(64, this.host.readTimestampCounter());
  }

  /** 0c6310 retains the original affinity truncation, clock reads, and signed TSC division. */
  measureClockMegahertz(): number {
    const previousAffinity = this.host.setCurrentThreadAffinity(1n);
    const initial = Number(BigInt.asUintN(32, this.clock.read()));
    while (Number(BigInt.asUintN(32, this.clock.read())) === initial) {
      /* native millisecond transition */
    }
    const first = this.readTimestampCounter();
    const deadline = (Number(BigInt.asUintN(32, this.clock.read())) + 1000) >>> 0;
    while (Number(BigInt.asUintN(32, this.clock.read())) < deadline) {
      /* native one-second measurement */
    }
    const last = this.readTimestampCounter();
    this.host.setCurrentThreadAffinity(BigInt.asUintN(32, previousAffinity));
    return Number(BigInt.asUintN(32, BigInt.asIntN(64, last - first) / 1000000n));
  }

  /** 0c6580, with the SSE2/SSE wrappers selecting bits 26/25. */
  feature(bit: number): boolean {
    const values = this.query(1, 0);
    return values !== null && ((values[3] >>> (bit & 31)) & 1) !== 0;
  }

  private initializeIdentity(): boolean {
    const basic = this.query(0, 0);
    if (basic === null) return false;
    const bytes = registerBytes([basic[1], basic[3], basic[2]]);
    let vendor = '';
    for (const value of bytes) {
      if (value === 0) break;
      vendor += String.fromCharCode(value);
    }
    const index = ['GenuineIntel', 'AuthenticAMD', 'CentaurHauls', 'GenuineTMx86'].indexOf(vendor);
    this.record[0] = index < 0 ? 4 : index;
    const version = this.query(1, 0);
    if (version === null) return false;
    const family = (version[0] >>> 8) & 15;
    this.record[1] =
      family === 0 || family === 15 ? family | ((version[0] >>> 16) & 0xff0) : family;
    this.record[2] = (((version[0] >>> 8) & 0xf00) | (version[0] & 0xf0)) >>> 4;
    this.record[3] = version[0] & 15;
    if (this.record[0] === 0) this.record[4] = version[1] & 255;
    else {
      const extended = this.query(0x80000001, 0);
      if (extended === null) return false;
      this.record[4] = extended[1] & 65535;
    }
    return true;
  }

  private initializeDeterministicCaches(): void {
    for (let subleaf = 0; subleaf < 4; subleaf++) {
      const values = this.query(4, subleaf);
      if (values === null || (((values[0] & 31) - 1) & 0xfffffffd) !== 0) continue;
      const lineSize = (values[1] & 4095) + 1;
      const partitions = ((values[1] >>> 12) & 1023) + 1;
      const ways = (values[1] >>> 22) + 1;
      const sets = (values[2] + 1) | 0;
      const size = Math.imul(Math.imul(Math.imul(partitions, sets), ways), lineSize) >>> 10;
      const packed = size | (((lineSize << 8) | ways) << 16);
      const level = (values[0] >>> 5) & 7;
      if (level >= 1 && level <= 3) this.record[level + 4] = packed;
    }
  }

  private initializeIntelCaches(): void {
    let values = this.query(2, 0);
    if (values === null) return;
    const count = values[0] & 255;
    const reports: Uint8Array[] = [];
    // Native collects every leaf-2 report before scanning its descriptors.
    for (let i = 0; i < count; i++) {
      values = this.query(2, 0) ?? values;
      const filtered = values.map((value, index) => {
        value = index === 0 ? value & 0xffffff00 : value | 0;
        return value < 0 ? 0 : value;
      });
      reports.push(registerBytes(filtered));
    }
    for (const report of reports)
      for (const descriptor of report) {
        if (descriptor === 0xff) this.initializeDeterministicCaches();
        else if (descriptor === 0x49) this.record[this.record[1] === 15 ? 7 : 6] = 0x40101000;
        else {
          const entry = descriptors[descriptor];
          if (entry !== undefined) this.record[entry[0]] = entry[1];
        }
      }
  }

  private initializeExtendedCaches(): void {
    const first = this.query(0x80000005, 0);
    if (first === null) return;
    const l1 = first[2];
    this.record[5] = (l1 & 0xff0000) | (l1 << 24) | (l1 >>> 24);
    const second = this.query(0x80000006, 0);
    if (second === null) return;
    const l2 = second[2],
      associativity = (l2 >>> 12) & 15;
    const ways = associativity === 0 ? 0 : 1 << (associativity >>> 1);
    this.record[6] = (((l2 << 8) | ways) << 16) | (l2 >>> 16);
  }

  /** 0c5b40: identity, vendor-specific caches, measured MHz, Windows count, first core. */
  initialize(): boolean {
    if (!this.initializeIdentity()) return false;
    this.record[5] = this.record[6] = this.record[7] = 0;
    if (this.record[0] === 0) this.initializeIntelCaches();
    else this.initializeExtendedCaches();
    this.record[8] = this.measureClockMegahertz();
    this.record[9] = this.host.logicalProcessorCount();
    this.record[10] = this.firstCoreLogicalProcessorCount();
    return true;
  }

  /** 0c5ab0 plus 0f8000: query 48 brand bytes and normalize ASCII spaces only. */
  brand(): Uint8Array | null {
    let values = this.query(0x80000000, 0);
    if (values === null) return null;
    const bytes = new Uint8Array(48);
    for (let i = 0; i < 3; i++) {
      values = this.query(0x80000002 + i, 0) ?? values;
      bytes.set(registerBytes(values), i * 16);
    }
    const end = bytes.indexOf(0);
    if (end < 0) throw new Error('Buriko CPU brand has no terminator in its native record');
    return normalizeBurikoAsciiSpaces({bytes, offset: 0});
  }
}
