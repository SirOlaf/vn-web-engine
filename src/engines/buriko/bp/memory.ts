import type {BurikoBpThread} from './state.js';
import {byteDataView} from '../../../core/binary.js';
import {
  clearIndeterminateMemory,
  copyMemoryBytes,
  provenanceDataView,
  requireDeterminateMemory,
} from '../../../core/indeterminate-memory.js';
import {BURIKO_BP_ABI_172, type BurikoBpAbi} from './abi.js';

/** A native byte pointer: views of one backing buffer continue to overlap. */
export interface BurikoBpPointer {
  readonly bytes: Uint8Array;
  readonly offset: number;
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

/** FUN_14006e110..3d0: byte-granular first fit, ascending free list, newest-first allocations. */
export class BurikoBpHeap {
  bytes = new Uint8Array(0x8000);
  readonly freeBlocks: HeapBlock[] = [{offset: 0, size: 0x8000}];
  readonly allocations: HeapBlock[] = [];

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
      const previous = this.bytes.byteLength;
      if (previous === 0) throw new Error('Buriko heap has been destroyed');
      let capacity = previous * 2;
      while (capacity - previous < size) capacity *= 2;
      if (capacity > 0xffffffff)
        throw new RangeError('Buriko heap growth overflows its 32-bit size');
      const bytes = new Uint8Array(capacity);
      copyMemoryBytes(bytes, 0, this.bytes, 0, previous);
      this.bytes = bytes;
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
    this.bytes = new Uint8Array();
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

interface IndirectRecord {
  bytes: Uint8Array | null;
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
  const {bytes, offset} = pointer;
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

/** The exact title-local resolver and native allocation tables; no host pointer objects in VM cells. */
export class BurikoBpMemory {
  readonly pools: (BurikoBpPointer | null)[][];
  readonly indirectBanks: (IndirectRecord | null)[][] = [
    Array<IndirectRecord | null>(256).fill(null),
    Array<IndirectRecord | null>(256).fill(null),
  ];
  private indirectNext = [0, 0];

  private globalBytes: Uint8Array;

  constructor(
    globalMemory: Uint8Array,
    readonly abi: BurikoBpAbi = BURIKO_BP_ABI_172,
  ) {
    this.globalBytes = globalMemory;
    // 00463800 assigns one complete 26-bit-offset bank per allocation, in first-free order.
    this.pools =
      abi.compatibility === '1.69'
        ? [Array<BurikoBpPointer | null>(48).fill(null)]
        : BURIKO_BP_POOL_LAYOUT.map((group) =>
            Array<BurikoBpPointer | null>(group.slots).fill(null),
          );
  }

  /** Live DAT1E9080; existing pointers retain their own native allocation identity. */
  get globalMemory(): Uint8Array {
    return this.globalBytes;
  }

  /** C1200 replaces and zeroes the actual BP arena; no other memory bank is reset. */
  resizeGlobal(exponent: number): 0 | 1 {
    exponent >>>= 0;
    if (exponent >= 13) return 0;
    this.globalBytes = new Uint8Array(0x1000 << exponent);
    return 1;
  }

  /** E82F0 clears the current configured global arena. */
  clearGlobal(): void {
    this.globalBytes.fill(0);
    clearIndeterminateMemory(this.globalBytes, 0, this.globalBytes.length);
  }

  resolve(thread: BurikoBpThread, address: number): BurikoBpPointer | null {
    address >>>= 0;
    if (address === 0) return null;
    const bank = address >>> this.abi.addressBits;
    const offset = address & this.abi.addressMask;
    if (bank === 0) {
      if (!this.abi.indirectHandles || (address & 0x0fff0000) !== 0x0fff0000)
        return {bytes: this.globalMemory, offset};
      const selector = (address >>> 12) & 15;
      if (selector > 1) return null;
      const bytes = this.indirectBanks[selector]![address & 255]?.bytes;
      return bytes ? {bytes, offset: 0} : null;
    }
    if (bank === 1) return {bytes: thread.moduleMemory, offset};
    if (bank === 2) return {bytes: thread.frameMemory, offset};
    if (bank === 3) {
      if (!thread.heap) throw new BurikoBpMemoryFault(address, 'Thread has no allocator');
      return {bytes: thread.heap.bytes, offset};
    }
    if (this.abi.compatibility === '1.69') {
      if (bank < 16) throw new BurikoBpMemoryFault(address, 'Invalid memory bank');
      const base = this.pools[0]![bank - 16];
      if (!base) throw new BurikoBpMemoryFault(address, 'Unresolved pooled allocation');
      return {bytes: base.bytes, offset: base.offset + offset};
    }
    const index = BURIKO_BP_POOL_LAYOUT.findIndex(
      (group) => bank >= group.firstBank && bank < group.endBank,
    );
    const group = BURIKO_BP_POOL_LAYOUT[index]!;
    const slot =
      ((bank - group.firstBank) << (28 - group.offsetBits)) | (offset >>> group.offsetBits);
    const base = this.pools[index]![slot];
    if (!base) throw new BurikoBpMemoryFault(address, 'Unresolved pooled allocation');
    return {bytes: base.bytes, offset: base.offset + (address & group.offsetMask)};
  }

  pointer(thread: BurikoBpThread, address: number, size = 0): BurikoBpPointer {
    const pointer = this.resolve(thread, address);
    if (!pointer) throw new BurikoBpMemoryFault(address, 'Null memory access');
    if (pointer.offset < 0 || size < 0 || pointer.offset + size > pointer.bytes.byteLength) {
      throw new BurikoBpMemoryFault(address, 'Memory access outside backing allocation');
    }
    return pointer;
  }

  private scalarPointer(thread: BurikoBpThread, address: number, size: number): BurikoBpPointer {
    const pointer = this.pointer(thread, address, size);
    // pointer() preserves native address faults; pointerView's integer guard follows it.
    if (!Number.isInteger(pointer.offset))
      throw new RangeError('Buriko pointer exceeds its byte view');
    return pointer;
  }

  readU8(t: BurikoBpThread, a: number): number {
    const p = this.scalarPointer(t, a, 1);
    requireDeterminateMemory(p.bytes, p.offset, 1);
    return byteDataView(p.bytes).getUint8(p.offset);
  }
  readI8(t: BurikoBpThread, a: number): number {
    const p = this.scalarPointer(t, a, 1);
    requireDeterminateMemory(p.bytes, p.offset, 1);
    return byteDataView(p.bytes).getInt8(p.offset);
  }
  readU16(t: BurikoBpThread, a: number): number {
    const p = this.scalarPointer(t, a, 2);
    requireDeterminateMemory(p.bytes, p.offset, 2);
    return byteDataView(p.bytes).getUint16(p.offset, true);
  }
  readI16(t: BurikoBpThread, a: number): number {
    const p = this.scalarPointer(t, a, 2);
    requireDeterminateMemory(p.bytes, p.offset, 2);
    return byteDataView(p.bytes).getInt16(p.offset, true);
  }
  readU32(t: BurikoBpThread, a: number): number {
    const p = this.scalarPointer(t, a, 4);
    requireDeterminateMemory(p.bytes, p.offset, 4);
    return byteDataView(p.bytes).getUint32(p.offset, true);
  }
  readI32(t: BurikoBpThread, a: number): number {
    const p = this.scalarPointer(t, a, 4);
    requireDeterminateMemory(p.bytes, p.offset, 4);
    return byteDataView(p.bytes).getInt32(p.offset, true);
  }
  readU64(t: BurikoBpThread, a: number): bigint {
    const p = this.scalarPointer(t, a, 8);
    requireDeterminateMemory(p.bytes, p.offset, 8);
    return byteDataView(p.bytes).getBigUint64(p.offset, true);
  }
  readI64(t: BurikoBpThread, a: number): bigint {
    const p = this.scalarPointer(t, a, 8);
    requireDeterminateMemory(p.bytes, p.offset, 8);
    return byteDataView(p.bytes).getBigInt64(p.offset, true);
  }
  writeU8(t: BurikoBpThread, a: number, v: number): void {
    const p = this.scalarPointer(t, a, 1);
    byteDataView(p.bytes).setUint8(p.offset, v);
    clearIndeterminateMemory(p.bytes, p.offset, 1);
  }
  writeU16(t: BurikoBpThread, a: number, v: number): void {
    const p = this.scalarPointer(t, a, 2);
    byteDataView(p.bytes).setUint16(p.offset, v, true);
    clearIndeterminateMemory(p.bytes, p.offset, 2);
  }
  writeU32(t: BurikoBpThread, a: number, v: number): void {
    const p = this.scalarPointer(t, a, 4);
    byteDataView(p.bytes).setUint32(p.offset, v, true);
    clearIndeterminateMemory(p.bytes, p.offset, 4);
  }
  writeU64(t: BurikoBpThread, a: number, v: bigint): void {
    const p = this.scalarPointer(t, a, 8);
    byteDataView(p.bytes).setBigUint64(p.offset, v, true);
    clearIndeterminateMemory(p.bytes, p.offset, 8);
  }

  readCString(thread: BurikoBpThread, address: number): Uint8Array {
    const {bytes, offset} = this.pointer(thread, address);
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
    copyMemoryBytes(target.bytes, target.offset, input.bytes, input.offset, size);
  }

  allocatePooled(size: number): number {
    size >>>= 0;
    if (this.abi.compatibility === '1.69') {
      const table = this.pools[0]!,
        slot = table.indexOf(null);
      if (slot < 0) return 0;
      table[slot] = {bytes: new Uint8Array(size), offset: 0};
      return ((slot + 16) * 0x04000000) >>> 0;
    }
    for (let index = 0; index < BURIKO_BP_POOL_LAYOUT.length; index++) {
      const group = BURIKO_BP_POOL_LAYOUT[index]!;
      if (size > group.maxSize) continue;
      const table = this.pools[index]!;
      const slot = table.indexOf(null);
      if (slot < 0) continue;
      table[slot] = {bytes: new Uint8Array(size), offset: 0};
      return ((group.firstBank << 28) + slot * 2 ** group.offsetBits) >>> 0;
    }
    return 0;
  }

  freePooled(address: number): boolean {
    address >>>= 0;
    if (this.abi.compatibility === '1.69') {
      const slot = (address >>> 26) - 16;
      if (slot < 0 || (address & 0x03ffffff) !== 0 || !this.pools[0]![slot]) return false;
      this.pools[0]![slot] = null;
      return true;
    }
    const bank = address >>> 28;
    for (let index = 0; index < BURIKO_BP_POOL_LAYOUT.length; index++) {
      const group = BURIKO_BP_POOL_LAYOUT[index]!;
      if (bank < group.firstBank || bank >= group.endBank || (address & group.offsetMask) !== 0)
        continue;
      const slot =
        ((bank - group.firstBank) << (28 - group.offsetBits)) |
        ((address & 0xfffffff) >>> group.offsetBits);
      if (this.pools[index]![slot]) {
        this.pools[index]![slot] = null;
        return true;
      }
    }
    return false;
  }

  /** EE4C0 frees and zeros the six initialized pooled allocation tables. */
  clearPooled(): void {
    for (const table of this.pools) table.fill(null);
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
      throw new Error('Buriko compatibility 1.69 has no indirect buffer/string handle ABI');
    const bank = this.indirectBanks[selector]!;
    for (let remaining = 256; remaining > 0; remaining--) {
      const slot = (this.indirectNext[selector] = (this.indirectNext[selector]! + 31) & 255);
      if (bank[slot]) continue;
      const bytes = allocate();
      bank[slot] = {bytes, size: bytes?.byteLength ?? 0};
      return {result: 0, address: (0x0fff0000 | (selector << 12) | slot) >>> 0};
    }
    return {result: ALLOCATION_FAILED};
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
    if (!this.indirect(address, selector)) return INVALID_HANDLE;
    this.indirectBanks[selector]![address & 255] = null;
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
    const bytes = size === 0 ? null : new Uint8Array(size);
    if (bytes && record.bytes)
      copyMemoryBytes(bytes, 0, record.bytes, 0, Math.min(size, record.size));
    record.bytes = bytes;
    record.size = size;
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
      copyMemoryBytes(destination.bytes, destination.offset, record.bytes!, offset, size);
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
      copyMemoryBytes(record.bytes!, offset, source.bytes, source.offset, size);
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
    const bytes = nextSize === 0 ? null : new Uint8Array(nextSize);
    if (record.bytes && bytes) copyMemoryBytes(bytes, 0, record.bytes, 0, offset);
    if (size !== 0) {
      if (!source) throw new BurikoBpMemoryFault(0, 'Null indirect buffer source');
      pointerView(source, size);
      copyMemoryBytes(bytes!, offset, source.bytes, source.offset, size);
    }
    if (record.bytes && bytes)
      copyMemoryBytes(bytes, offset + size, record.bytes, offset, record.size - offset);
    record.bytes = bytes;
    record.size = nextSize;
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
    const bytes = new Uint8Array(size);
    bytes.set(record.bytes!.subarray(0, offset));
    bytes.set(content, offset);
    bytes.set(record.bytes!.subarray(offset, length), offset + content.byteLength);
    record.bytes = bytes;
    record.size = size;
    return 0;
  }

  clearString(address: number): number {
    const record = this.indirect(address, 1);
    if (!record) return INVALID_HANDLE;
    record.bytes = new Uint8Array(1);
    record.size = 1;
    return 0;
  }
}
