import type {BurikoBpThread} from './state.js';
import {byteDataView} from '../../../core/binary.js';
import {
  clearIndeterminateMemory,
  copyMemoryBytes,
  provenanceDataView,
  requireDeterminateMemory,
} from '../../../core/indeterminate-memory.js';
import {BURIKO_BP_ABI_172, type BurikoBpAbi} from './abi.js';
import {BurikoBpWasmCore} from './wasm-core.js';
import {
  BurikoBpPointer,
  BurikoBpRegion,
  BurikoBpRegionTable,
  type BurikoBpArenaViews,
} from './region.js';

/** First arena reservation of a VM memory; the arena doubles on demand. */
export const BURIKO_BP_ARENA_BYTES = 0x100000;

export {BurikoBpPointer, BurikoBpRegion, BurikoBpRegionTable, hostPointer} from './region.js';

// scalarBytes has already bounds-checked these little-endian accesses.
function u16At(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}
function i32At(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  );
}
/** DataView setters apply ToNumber before ToUint32; typed stores then take the low bytes. */
function toUint32(value: number): number {
  return Number(value) >>> 0;
}

export class BurikoBpMemoryFault extends Error {
  constructor(
    readonly address: number,
    message: string,
  ) {
    super(`${message} (Buriko address 0x${(address >>> 0).toString(16).padStart(8, '0')})`);
    this.name = 'BurikoBpMemoryFault';
  }
}

interface HeapBlock {
  offset: number;
  size: number;
}

/** 14006e110..3d0 and1.66500436010..260: byte-granular first fit, ascending free list, newest-first allocations. */
export class BurikoBpHeap {
  region: BurikoBpRegion;
  readonly freeBlocks: HeapBlock[] = [{offset: 0, size: 0x8000}];
  readonly allocations: HeapBlock[] = [];

  constructor(private readonly regions: BurikoBpRegionTable) {
    this.region = regions.allocate(0x8000);
  }

  allocate(size: number): number {
    size >>>= 0;
    for (;;) {
      const index = this.freeBlocks.findIndex((block) => size <= block.size);
      if (index >= 0) {
        const block = this.freeBlocks[index]!;
        const offset = block.offset;
        this.allocations.unshift({offset, size});
        if (size < block.size) {
          block.offset = (block.offset + size) >>> 0;
          block.size = (block.size - size) >>> 0;
        } else this.freeBlocks.splice(index, 1);
        return offset;
      }
      const previous = this.region.size;
      if (previous === 0) throw new Error('Buriko heap has been destroyed');
      let capacity = previous * 2;
      while (capacity - previous < size) capacity *= 2;
      if (capacity > 0xffffffff)
        throw new RangeError('Buriko heap growth overflows its 32-bit size');
      this.region = this.regions.relocate(this.region, capacity);
      this.freeBlocks.push({offset: previous, size: capacity - previous});
      this.coalesce();
    }
  }

  free(offset: number): boolean {
    offset >>>= 0;
    const index = this.allocations.findIndex((block) => block.offset === offset);
    if (index < 0) return false;
    const block = this.allocations.splice(index, 1)[0]!;
    const insertion = this.freeBlocks.findIndex((free) => block.offset < free.offset);
    this.freeBlocks.splice(insertion < 0 ? this.freeBlocks.length : insertion, 0, block);
    this.coalesce();
    return true;
  }

  private coalesce(): void {
    for (let index = 0; index + 1 < this.freeBlocks.length;) {
      const first = this.freeBlocks[index]!;
      const second = this.freeBlocks[index + 1]!;
      if ((first.offset + first.size) >>> 0 === second.offset) {
        first.size = (first.size + second.size) >>> 0;
        this.freeBlocks.splice(index + 1, 1);
      } else index++;
    }
  }

  dispose(): void {
    this.freeBlocks.length = this.allocations.length = 0;
    this.regions.release(this.region);
    this.region = new BurikoBpRegion(new Uint8Array());
  }
}

// PE tables 140164620, 140164640, 140164660, 1401646a0, 1401646c0.
export const BURIKO_BP_POOL_LAYOUT = [
  {firstBank: 4, endBank: 5, offsetBits: 12, slots: 0x10000, maxSize: 0x1000, offsetMask: 0xfff},
  {firstBank: 5, endBank: 6, offsetBits: 16, slots: 0x1000, maxSize: 0x10000, offsetMask: 0xffff},
  {firstBank: 6, endBank: 7, offsetBits: 20, slots: 0x100, maxSize: 0x100000, offsetMask: 0xfffff},
  {firstBank: 7, endBank: 8, offsetBits: 24, slots: 0x10, maxSize: 0x1000000, offsetMask: 0xffffff},
  {
    firstBank: 8,
    endBank: 12,
    offsetBits: 26,
    slots: 0x10,
    maxSize: 0x4000000,
    offsetMask: 0x3ffffff,
  },
  {
    firstBank: 12,
    endBank: 16,
    offsetBits: 28,
    slots: 4,
    maxSize: 0x10000000,
    offsetMask: 0xfffffff,
  },
] as const;

/** 1.665 x86 tables00503c20/40/60,00503cc0,00503d20/40; bank width remains26 bits. */
export const BURIKO_BP_POOL_LAYOUT_1665 = [
  {firstBank: 16, endBank: 20, offsetBits: 12, slots: 0x10000, maxSize: 0x1000, offsetMask: 0xfff},
  {firstBank: 20, endBank: 24, offsetBits: 16, slots: 0x1000, maxSize: 0x10000, offsetMask: 0xffff},
  {
    firstBank: 24,
    endBank: 28,
    offsetBits: 20,
    slots: 0x100,
    maxSize: 0x100000,
    offsetMask: 0xfffff,
  },
  {
    firstBank: 28,
    endBank: 32,
    offsetBits: 24,
    slots: 0x10,
    maxSize: 0x1000000,
    offsetMask: 0xffffff,
  },
  {
    firstBank: 32,
    endBank: 64,
    offsetBits: 26,
    slots: 0x20,
    maxSize: 0x4000000,
    offsetMask: 0x3ffffff,
  },
] as const;

interface IndirectRecord {
  /** Null while the handle's size is zero. */
  region: BurikoBpRegion | null;
  size: number;
}
export interface BurikoBpAllocationResult {
  result: number;
  address?: number;
}
const INVALID_HANDLE = 0x80000009;
const INVALID_SIZE = 0x80000008;
const INVALID_OFFSET = 0x80000010;
const ALLOCATION_FAILED = 0x80000005;

export function pointerView(pointer: BurikoBpPointer, length?: number): DataView {
  const bytes = pointer.view(),
    offset = pointer.offset;
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > bytes.byteLength ||
    (length !== undefined &&
      (!Number.isInteger(length) || length < 0 || offset + length > bytes.byteLength))
  ) {
    throw new RangeError('Buriko pointer exceeds its byte view');
  }
  return provenanceDataView(bytes, offset, length ?? bytes.byteLength - offset);
}

/**
 * The exact title-local resolver and native allocation tables; no host pointer objects in VM
 * cells. Every bank resolves to a region from `regions`; addresses stay bank-relative.
 */
export class BurikoBpMemory {
  readonly regions: BurikoBpRegionTable;
  /** The WebAssembly interpreter core over this memory's arena, when available. */
  readonly wasm: BurikoBpWasmCore | null;
  readonly pools: (BurikoBpRegion | null)[][];
  private readonly poolLayout: typeof BURIKO_BP_POOL_LAYOUT | typeof BURIKO_BP_POOL_LAYOUT_1665;
  readonly indirectBanks: (IndirectRecord | null)[][] = [
    Array<IndirectRecord | null>(256).fill(null),
    Array<IndirectRecord | null>(256).fill(null),
  ];
  private indirectNext = [0, 0];

  private globalRegionValue: BurikoBpRegion;
  /** Offset written by the last `locate`; read immediately by its caller. */
  private located = 0;

  /**
   * `globalMemory` is copied into the arena; `memory.globalMemory` is the live arena bank.
   * `arenaBytes` is the arena's first reservation.
   */
  constructor(
    globalMemory: Uint8Array,
    readonly abi: BurikoBpAbi = BURIKO_BP_ABI_172,
    arenaBytes = BURIKO_BP_ARENA_BYTES,
  ) {
    const wasm = BurikoBpWasmCore.create(arenaBytes);
    this.regions = new BurikoBpRegionTable(arenaBytes, wasm ?? undefined);
    this.wasm = wasm?.core ?? null;
    this.wasm?.attach(this);
    this.globalRegionValue = this.regions.adopt(globalMemory);
    this.poolLayout = abi.revision === '1.665' ? BURIKO_BP_POOL_LAYOUT_1665 : BURIKO_BP_POOL_LAYOUT;
    // 00463800 assigns one complete 26-bit-offset bank per allocation, in first-free order.
    this.pools =
      abi.revision === '1.520.6'
        ? [Array<BurikoBpRegion | null>(48).fill(null)]
        : this.poolLayout.map((group) => Array<BurikoBpRegion | null>(group.slots).fill(null));
  }

  /** Whole-arena byte and word views of every live region, for the current arena generation. */
  memoryViews(): BurikoBpArenaViews {
    return this.regions.arena.views();
  }

  /** Live DAT1E9080; existing pointers retain their own native allocation identity. */
  get globalRegion(): BurikoBpRegion {
    return this.globalRegionValue;
  }

  /** The current global arena's bytes; see `BurikoBpRegion.view` for validity. */
  get globalMemory(): Uint8Array {
    return this.globalRegionValue.view();
  }

  /** C1200 replaces and zeroes the actual BP arena; no other memory bank is reset. */
  resizeGlobal(exponent: number): 0 | 1 {
    exponent >>>= 0;
    if (exponent >= 13) return 0;
    const previous = this.globalRegionValue;
    this.globalRegionValue = this.regions.allocate(0x1000 << exponent);
    this.regions.release(previous);
    return 1;
  }

  /** E82F0 clears the current configured global arena. */
  clearGlobal(): void {
    const bytes = this.globalMemory;
    bytes.fill(0);
    clearIndeterminateMemory(bytes, 0, bytes.length);
  }

  /** Bank resolution without a pointer object; the region offset is left in `located`. */
  private locate(thread: BurikoBpThread, address: number): BurikoBpRegion | null {
    const bank = address >>> this.abi.addressBits;
    const offset = address & this.abi.addressMask;
    if (bank === 0) {
      if (!this.abi.indirectHandles || (address & 0x0fff0000) !== 0x0fff0000) {
        this.located = offset;
        return this.globalRegionValue;
      }
      const selector = (address >>> 12) & 15;
      if (selector > 1) return null;
      this.located = 0;
      return this.indirectBanks[selector]![address & 255]?.region ?? null;
    }
    this.located = offset;
    if (bank === 1) return thread.moduleRegion;
    if (bank === 2) return thread.frameRegion;
    if (bank === 3) {
      const heap = thread.heap;
      if (!heap) throw new BurikoBpMemoryFault(address, 'Thread has no allocator');
      return heap.region;
    }
    if (this.abi.revision === '1.520.6') {
      if (bank < 16) throw new BurikoBpMemoryFault(address, 'Invalid memory bank');
      const base = this.pools[0]![bank - 16];
      if (!base) throw new BurikoBpMemoryFault(address, 'Unresolved pooled allocation');
      return base;
    }
    const index = this.poolLayout.findIndex(
      (group) => bank >= group.firstBank && bank < group.endBank,
    );
    if (index < 0) throw new BurikoBpMemoryFault(address, 'Invalid memory bank');
    const group = this.poolLayout[index]!;
    const slot =
      ((bank - group.firstBank) << (this.abi.addressBits - group.offsetBits)) |
      (offset >>> group.offsetBits);
    const base = this.pools[index]![slot];
    if (!base) throw new BurikoBpMemoryFault(address, 'Unresolved pooled allocation');
    this.located = address & group.offsetMask;
    return base;
  }

  resolve(thread: BurikoBpThread, address: number): BurikoBpPointer | null {
    address >>>= 0;
    if (address === 0) return null;
    const region = this.locate(thread, address);
    return region ? new BurikoBpPointer(region, this.located) : null;
  }

  pointer(thread: BurikoBpThread, address: number, size = 0): BurikoBpPointer {
    const pointer = this.resolve(thread, address);
    if (!pointer) throw new BurikoBpMemoryFault(address, 'Null memory access');
    if (pointer.offset < 0 || size < 0 || pointer.offset + size > pointer.region.size) {
      throw new BurikoBpMemoryFault(address, 'Memory access outside backing allocation');
    }
    return pointer;
  }

  /** `pointer()` without the pointer object; the checked offset is left in `located`. */
  private scalarBytes(thread: BurikoBpThread, address: number, size: number): Uint8Array {
    const unsigned = address >>> 0;
    const region = unsigned === 0 ? null : this.locate(thread, unsigned);
    if (!region) throw new BurikoBpMemoryFault(address, 'Null memory access');
    const bytes = region.view();
    if (this.located + size > bytes.byteLength) {
      throw new BurikoBpMemoryFault(address, 'Memory access outside backing allocation');
    }
    return bytes;
  }

  readU8(t: BurikoBpThread, a: number): number {
    const bytes = this.scalarBytes(t, a, 1),
      offset = this.located;
    requireDeterminateMemory(bytes, offset, 1);
    return bytes[offset]!;
  }
  readI8(t: BurikoBpThread, a: number): number {
    const bytes = this.scalarBytes(t, a, 1),
      offset = this.located;
    requireDeterminateMemory(bytes, offset, 1);
    return (bytes[offset]! << 24) >> 24;
  }
  readU16(t: BurikoBpThread, a: number): number {
    const bytes = this.scalarBytes(t, a, 2),
      offset = this.located;
    requireDeterminateMemory(bytes, offset, 2);
    return u16At(bytes, offset);
  }
  readI16(t: BurikoBpThread, a: number): number {
    const bytes = this.scalarBytes(t, a, 2),
      offset = this.located;
    requireDeterminateMemory(bytes, offset, 2);
    return (u16At(bytes, offset) << 16) >> 16;
  }
  readU32(t: BurikoBpThread, a: number): number {
    const bytes = this.scalarBytes(t, a, 4),
      offset = this.located;
    requireDeterminateMemory(bytes, offset, 4);
    return i32At(bytes, offset) >>> 0;
  }
  readI32(t: BurikoBpThread, a: number): number {
    const bytes = this.scalarBytes(t, a, 4),
      offset = this.located;
    requireDeterminateMemory(bytes, offset, 4);
    return i32At(bytes, offset);
  }
  readU64(t: BurikoBpThread, a: number): bigint {
    const bytes = this.scalarBytes(t, a, 8),
      offset = this.located;
    requireDeterminateMemory(bytes, offset, 8);
    return byteDataView(bytes).getBigUint64(offset, true);
  }
  readI64(t: BurikoBpThread, a: number): bigint {
    const bytes = this.scalarBytes(t, a, 8),
      offset = this.located;
    requireDeterminateMemory(bytes, offset, 8);
    return byteDataView(bytes).getBigInt64(offset, true);
  }
  writeU8(t: BurikoBpThread, a: number, v: number): void {
    const bytes = this.scalarBytes(t, a, 1),
      offset = this.located;
    bytes[offset] = toUint32(v);
    clearIndeterminateMemory(bytes, offset, 1);
  }
  writeU16(t: BurikoBpThread, a: number, v: number): void {
    const bytes = this.scalarBytes(t, a, 2),
      offset = this.located;
    const value = toUint32(v);
    bytes[offset] = value;
    bytes[offset + 1] = value >>> 8;
    clearIndeterminateMemory(bytes, offset, 2);
  }
  writeU32(t: BurikoBpThread, a: number, v: number): void {
    const bytes = this.scalarBytes(t, a, 4),
      offset = this.located;
    const value = toUint32(v);
    bytes[offset] = value;
    bytes[offset + 1] = value >>> 8;
    bytes[offset + 2] = value >>> 16;
    bytes[offset + 3] = value >>> 24;
    clearIndeterminateMemory(bytes, offset, 4);
  }
  writeU64(t: BurikoBpThread, a: number, v: bigint): void {
    const bytes = this.scalarBytes(t, a, 8),
      offset = this.located;
    byteDataView(bytes).setBigUint64(offset, v, true);
    clearIndeterminateMemory(bytes, offset, 8);
  }

  readCString(thread: BurikoBpThread, address: number): Uint8Array {
    const pointer = this.pointer(thread, address);
    const bytes = pointer.view(),
      offset = pointer.offset;
    let end = offset;
    for (; end < bytes.length; end++) {
      requireDeterminateMemory(bytes, end, 1);
      if (bytes[end] === 0) return bytes.subarray(offset, end);
    }
    throw new BurikoBpMemoryFault(address, 'Unterminated byte string');
  }

  copy(thread: BurikoBpThread, destination: number, source: number, size: number): void {
    size >>>= 0;
    if (size === 0) return;
    const target = this.pointer(thread, destination, size);
    const input = this.pointer(thread, source, size);
    copyMemoryBytes(target.view(), target.offset, input.view(), input.offset, size);
  }

  allocatePooled(size: number): number {
    size >>>= 0;
    if (this.abi.revision === '1.520.6') {
      const table = this.pools[0]!,
        slot = table.indexOf(null);
      if (slot < 0) return 0;
      table[slot] = this.regions.allocate(size);
      return ((slot + 16) * 0x04000000) >>> 0;
    }
    for (let index = 0; index < this.poolLayout.length; index++) {
      const group = this.poolLayout[index]!;
      if (size > group.maxSize) continue;
      const table = this.pools[index]!;
      const slot = table.indexOf(null);
      if (slot < 0) continue;
      table[slot] = this.regions.allocate(size);
      return ((group.firstBank << this.abi.addressBits) + slot * 2 ** group.offsetBits) >>> 0;
    }
    return 0;
  }

  freePooled(address: number): boolean {
    address >>>= 0;
    if (this.abi.revision === '1.520.6') {
      const slot = (address >>> 26) - 16;
      const region = slot < 0 ? null : this.pools[0]![slot];
      if ((address & 0x03ffffff) !== 0 || !region) return false;
      this.pools[0]![slot] = null;
      this.regions.release(region);
      return true;
    }
    const bank = address >>> this.abi.addressBits;
    for (let index = 0; index < this.poolLayout.length; index++) {
      const group = this.poolLayout[index]!;
      if (bank < group.firstBank || bank >= group.endBank || (address & group.offsetMask) !== 0)
        continue;
      const slot =
        ((bank - group.firstBank) << (this.abi.addressBits - group.offsetBits)) |
        ((address & this.abi.addressMask) >>> group.offsetBits);
      const region = this.pools[index]![slot];
      if (region) {
        this.pools[index]![slot] = null;
        this.regions.release(region);
        return true;
      }
    }
    return false;
  }

  /** EE4C0 / 1.6650049c400 frees and zeros the initialized pooled allocation tables. */
  clearPooled(): void {
    for (const table of this.pools) {
      for (const region of table) if (region) this.regions.release(region);
      table.fill(null);
    }
  }

  private indirect(address: number, selector: number): IndirectRecord | null {
    address >>>= 0;
    if (
      !this.abi.indirectHandles ||
      address >= 0x10000000 ||
      (address & 0x0fff0000) !== 0x0fff0000 ||
      ((address >>> 12) & 15) !== selector
    )
      return null;
    return this.indirectBanks[selector]![address & 255] ?? null;
  }

  private createIndirect(
    selector: number,
    allocate: () => Uint8Array | null,
  ): BurikoBpAllocationResult {
    if (!this.abi.indirectHandles)
      throw new Error(
        `Buriko revision ${this.abi.revision} has no indirect buffer/string handle ABI`,
      );
    const bank = this.indirectBanks[selector]!;
    for (let remaining = 256; remaining > 0; remaining--) {
      const slot = (this.indirectNext[selector] = (this.indirectNext[selector]! + 31) & 255);
      if (bank[slot]) continue;
      const bytes = allocate();
      bank[slot] = {region: bytes && this.regions.adopt(bytes), size: bytes?.byteLength ?? 0};
      return {result: 0, address: (0x0fff0000 | (selector << 12) | slot) >>> 0};
    }
    return {result: ALLOCATION_FAILED};
  }

  /** Installs a record's successor storage and retires the previous region. */
  private replaceIndirect(
    record: IndirectRecord,
    region: BurikoBpRegion | null,
    size: number,
  ): void {
    if (record.region) this.regions.release(record.region);
    record.region = region;
    record.size = size;
  }

  createBuffer(size: number): BurikoBpAllocationResult {
    size >>>= 0;
    if (size > 0x40000000) return {result: INVALID_SIZE};
    return this.createIndirect(0, () => (size === 0 ? null : new Uint8Array(size)));
  }

  createString(input: Uint8Array | null | (() => Uint8Array | null)): BurikoBpAllocationResult {
    return this.createIndirect(1, () => {
      const bytes = typeof input === 'function' ? input() : input;
      const content =
        bytes?.subarray(0, bytes.indexOf(0) < 0 ? bytes.byteLength : bytes.indexOf(0)) ??
        new Uint8Array();
      const terminated = new Uint8Array(content.byteLength + 1);
      terminated.set(content);
      return terminated;
    });
  }

  freeIndirect(address: number, selector: 0 | 1): number {
    const record = this.indirect(address, selector);
    if (!record) return INVALID_HANDLE;
    this.indirectBanks[selector]![address & 255] = null;
    if (record.region) this.regions.release(record.region);
    return 0;
  }

  bufferSize(address: number): {result: number; size?: number} {
    const record = this.indirect(address, 0);
    return record ? {result: 0, size: record.size} : {result: INVALID_HANDLE};
  }

  resizeBuffer(address: number, size: number): number {
    size >>>= 0;
    if (size > 0x40000000) return INVALID_SIZE;
    const record = this.indirect(address, 0);
    if (!record) return INVALID_HANDLE;
    const region = size === 0 ? null : this.regions.allocate(size);
    if (region && record.region)
      copyMemoryBytes(region.view(), 0, record.region.view(), 0, Math.min(size, record.size));
    this.replaceIndirect(record, region, size);
    return 0;
  }

  readBuffer(
    address: number,
    offset: number,
    destination: BurikoBpPointer | null,
    size: number,
  ): number {
    const record = this.indirect(address, 0);
    if (!record) return INVALID_HANDLE;
    offset >>>= 0;
    size >>>= 0;
    if (offset >= record.size) return INVALID_OFFSET;
    if (record.size - offset < size) return INVALID_SIZE;
    if (size !== 0) {
      if (!destination) throw new BurikoBpMemoryFault(0, 'Null indirect buffer destination');
      pointerView(destination, size);
      copyMemoryBytes(destination.view(), destination.offset, record.region!.view(), offset, size);
    }
    return 0;
  }

  writeBuffer(
    address: number,
    offset: number,
    source: BurikoBpPointer | null,
    size: number,
  ): number {
    const record = this.indirect(address, 0);
    if (!record) return INVALID_HANDLE;
    offset >>>= 0;
    size >>>= 0;
    if (offset >= record.size) return INVALID_OFFSET;
    if (record.size - offset < size) return INVALID_SIZE;
    if (size !== 0) {
      if (!source) throw new BurikoBpMemoryFault(0, 'Null indirect buffer source');
      pointerView(source, size);
      copyMemoryBytes(record.region!.view(), offset, source.view(), source.offset, size);
    }
    return 0;
  }

  insertBuffer(
    address: number,
    offset: number,
    source: BurikoBpPointer | null,
    size: number,
  ): number {
    const record = this.indirect(address, 0);
    if (!record) return INVALID_HANDLE;
    size >>>= 0;
    offset = (offset | 0) < 0 ? record.size : offset >>> 0;
    if (offset > record.size) return INVALID_OFFSET;
    const nextSize = (record.size + size) >>> 0;
    if (nextSize > 0x40000000) return INVALID_SIZE;
    // Source faults leave the record unchanged, so they are raised before allocating.
    if (size !== 0) {
      if (!source) throw new BurikoBpMemoryFault(0, 'Null indirect buffer source');
      pointerView(source, size);
    }
    const region = nextSize === 0 ? null : this.regions.allocate(nextSize);
    const bytes = region?.view() ?? null;
    const previous = record.region?.view() ?? null;
    if (previous && bytes) copyMemoryBytes(bytes, 0, previous, 0, offset);
    if (size !== 0) copyMemoryBytes(bytes!, offset, source!.view(), source!.offset, size);
    if (previous && bytes)
      copyMemoryBytes(bytes, offset + size, previous, offset, record.size - offset);
    this.replaceIndirect(record, region, nextSize);
    return 0;
  }

  stringInsertionStatus(address: number, offset: number): number {
    const record = this.indirect(address, 1);
    if (!record) return INVALID_HANDLE;
    return (offset | 0) >= 0 && offset >>> 0 > record.size - 1 ? INVALID_OFFSET : 0;
  }

  /** Input is the completed native formatter output, before its terminating NUL. */
  insertStringBytes(address: number, offset: number, content: Uint8Array): number {
    const record = this.indirect(address, 1);
    if (!record) return INVALID_HANDLE;
    const length = record.size - 1;
    offset = (offset | 0) < 0 ? length : offset >>> 0;
    if (offset > length) return INVALID_OFFSET;
    const terminator = content.indexOf(0);
    if (terminator >= 0) content = content.subarray(0, terminator);
    const size = (record.size + content.byteLength) >>> 0;
    if (size > 0x40000000) return INVALID_SIZE;
    const previous = record.region!.view();
    const bytes = new Uint8Array(size);
    bytes.set(previous.subarray(0, offset));
    bytes.set(content, offset);
    bytes.set(previous.subarray(offset, length), offset + content.byteLength);
    this.replaceIndirect(record, this.regions.adopt(bytes), size);
    return 0;
  }

  clearString(address: number): number {
    const record = this.indirect(address, 1);
    if (!record) return INVALID_HANDLE;
    this.replaceIndirect(record, this.regions.allocate(1), 1);
    return 0;
  }
}
