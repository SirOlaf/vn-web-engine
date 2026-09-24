import type {AokanaBpThread} from './state.js';

/** A native byte pointer: views of one backing buffer continue to overlap. */
export interface AokanaBpPointer {
  readonly bytes: Uint8Array;
  readonly offset: number;
}

export class AokanaBpMemoryFault extends Error {
  constructor(
    readonly address: number,
    message: string,
  ) {
    super(`${message} (Aokana address 0x${(address >>> 0).toString(16).padStart(8, '0')})`);
    this.name = 'AokanaBpMemoryFault';
  }
}

interface HeapBlock {
  offset: number;
  size: number;
}

/** FUN_14006e110..3d0: byte-granular first fit, ascending free list, newest-first allocations. */
export class AokanaBpHeap {
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
      if (previous === 0) throw new Error('Aokana heap has been destroyed');
      let capacity = previous * 2;
      while (capacity - previous < size) capacity *= 2;
      if (capacity > 0xffffffff)
        throw new RangeError('Aokana heap growth overflows its 32-bit size');
      const bytes = new Uint8Array(capacity);
      bytes.set(this.bytes);
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
export const AOKANA_BP_POOL_LAYOUT = [
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
export interface AokanaBpAllocationResult {
  result: number;
  address?: number;
}
const INVALID_HANDLE = 0x80000009;
const INVALID_SIZE = 0x80000008;
const INVALID_OFFSET = 0x80000010;
const ALLOCATION_FAILED = 0x80000005;

export function pointerView(pointer: AokanaBpPointer, length?: number): DataView {
  const {bytes, offset} = pointer;
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > bytes.byteLength ||
    (length !== undefined &&
      (!Number.isInteger(length) || length < 0 || offset + length > bytes.byteLength))
  ) {
    throw new RangeError('Aokana pointer exceeds its byte view');
  }
  return new DataView(bytes.buffer, bytes.byteOffset + offset, length ?? bytes.byteLength - offset);
}

/** The exact title-local resolver and native allocation tables; no host pointer objects in VM cells. */
export class AokanaBpMemory {
  readonly pools: (AokanaBpPointer | null)[][] = AOKANA_BP_POOL_LAYOUT.map((group) =>
    Array<AokanaBpPointer | null>(group.slots).fill(null),
  );
  readonly indirectBanks: (IndirectRecord | null)[][] = [
    Array<IndirectRecord | null>(256).fill(null),
    Array<IndirectRecord | null>(256).fill(null),
  ];
  private indirectNext = [0, 0];

  private globalBytes: Uint8Array;

  constructor(globalMemory: Uint8Array) {
    this.globalBytes = globalMemory;
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
  }

  resolve(thread: AokanaBpThread, address: number): AokanaBpPointer | null {
    address >>>= 0;
    if (address === 0) return null;
    const bank = address >>> 28;
    const offset = address & 0x0fffffff;
    if (bank === 0) {
      if ((address & 0x0fff0000) !== 0x0fff0000) return {bytes: this.globalMemory, offset};
      const selector = (address >>> 12) & 15;
      if (selector > 1) return null;
      const bytes = this.indirectBanks[selector]![address & 255]?.bytes;
      return bytes ? {bytes, offset: 0} : null;
    }
    if (bank === 1) return {bytes: thread.moduleMemory, offset};
    if (bank === 2) return {bytes: thread.frameMemory, offset};
    if (bank === 3) {
      if (!thread.heap) throw new AokanaBpMemoryFault(address, 'Thread has no allocator');
      return {bytes: thread.heap.bytes, offset};
    }
    const index = AOKANA_BP_POOL_LAYOUT.findIndex(
      (group) => bank >= group.firstBank && bank < group.endBank,
    );
    const group = AOKANA_BP_POOL_LAYOUT[index]!;
    const slot =
      ((bank - group.firstBank) << (28 - group.offsetBits)) | (offset >>> group.offsetBits);
    const base = this.pools[index]![slot];
    if (!base) throw new AokanaBpMemoryFault(address, 'Unresolved pooled allocation');
    return {bytes: base.bytes, offset: base.offset + (address & group.offsetMask)};
  }

  pointer(thread: AokanaBpThread, address: number, size = 0): AokanaBpPointer {
    const pointer = this.resolve(thread, address);
    if (!pointer) throw new AokanaBpMemoryFault(address, 'Null memory access');
    if (pointer.offset < 0 || size < 0 || pointer.offset + size > pointer.bytes.byteLength) {
      throw new AokanaBpMemoryFault(address, 'Memory access outside backing allocation');
    }
    return pointer;
  }

  private view(thread: AokanaBpThread, address: number, size: number): DataView {
    return pointerView(this.pointer(thread, address, size), size);
  }

  readU8(t: AokanaBpThread, a: number): number {
    return this.view(t, a, 1).getUint8(0);
  }
  readI8(t: AokanaBpThread, a: number): number {
    return this.view(t, a, 1).getInt8(0);
  }
  readU16(t: AokanaBpThread, a: number): number {
    return this.view(t, a, 2).getUint16(0, true);
  }
  readI16(t: AokanaBpThread, a: number): number {
    return this.view(t, a, 2).getInt16(0, true);
  }
  readU32(t: AokanaBpThread, a: number): number {
    return this.view(t, a, 4).getUint32(0, true);
  }
  readI32(t: AokanaBpThread, a: number): number {
    return this.view(t, a, 4).getInt32(0, true);
  }
  readU64(t: AokanaBpThread, a: number): bigint {
    return this.view(t, a, 8).getBigUint64(0, true);
  }
  readI64(t: AokanaBpThread, a: number): bigint {
    return this.view(t, a, 8).getBigInt64(0, true);
  }
  writeU8(t: AokanaBpThread, a: number, v: number): void {
    this.view(t, a, 1).setUint8(0, v);
  }
  writeU16(t: AokanaBpThread, a: number, v: number): void {
    this.view(t, a, 2).setUint16(0, v, true);
  }
  writeU32(t: AokanaBpThread, a: number, v: number): void {
    this.view(t, a, 4).setUint32(0, v, true);
  }
  writeU64(t: AokanaBpThread, a: number, v: bigint): void {
    this.view(t, a, 8).setBigUint64(0, v, true);
  }

  readCString(thread: AokanaBpThread, address: number): Uint8Array {
    const {bytes, offset} = this.pointer(thread, address);
    const end = bytes.indexOf(0, offset);
    if (end < 0) throw new AokanaBpMemoryFault(address, 'Unterminated byte string');
    return bytes.subarray(offset, end);
  }

  copy(thread: AokanaBpThread, destination: number, source: number, size: number): void {
    size >>>= 0;
    if (size === 0) return;
    const target = this.pointer(thread, destination, size);
    const input = this.pointer(thread, source, size);
    target.bytes.set(input.bytes.subarray(input.offset, input.offset + size), target.offset);
  }

  allocatePooled(size: number): number {
    size >>>= 0;
    for (let index = 0; index < AOKANA_BP_POOL_LAYOUT.length; index++) {
      const group = AOKANA_BP_POOL_LAYOUT[index]!;
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
    const bank = address >>> 28;
    for (let index = 0; index < AOKANA_BP_POOL_LAYOUT.length; index++) {
      const group = AOKANA_BP_POOL_LAYOUT[index]!;
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

  private indirect(address: number, selector: number): IndirectRecord | null {
    address >>>= 0;
    if (
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
  ): AokanaBpAllocationResult {
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

  createBuffer(size: number): AokanaBpAllocationResult {
    size >>>= 0;
    if (size > 0x40000000) return {result: INVALID_SIZE};
    return this.createIndirect(0, () => (size === 0 ? null : new Uint8Array(size)));
  }

  createString(input: Uint8Array | null | (() => Uint8Array | null)): AokanaBpAllocationResult {
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
    if (bytes && record.bytes) bytes.set(record.bytes.subarray(0, size));
    record.bytes = bytes;
    record.size = size;
    return 0;
  }

  readBuffer(
    address: number,
    offset: number,
    destination: AokanaBpPointer | null,
    size: number,
  ): number {
    const record = this.indirect(address, 0);
    if (!record) return INVALID_HANDLE;
    offset >>>= 0;
    size >>>= 0;
    if (offset >= record.size) return INVALID_OFFSET;
    if (record.size - offset < size) return INVALID_SIZE;
    if (size !== 0) {
      if (!destination) throw new AokanaBpMemoryFault(0, 'Null indirect buffer destination');
      pointerView(destination, size);
      destination.bytes.set(record.bytes!.subarray(offset, offset + size), destination.offset);
    }
    return 0;
  }

  writeBuffer(
    address: number,
    offset: number,
    source: AokanaBpPointer | null,
    size: number,
  ): number {
    const record = this.indirect(address, 0);
    if (!record) return INVALID_HANDLE;
    offset >>>= 0;
    size >>>= 0;
    if (offset >= record.size) return INVALID_OFFSET;
    if (record.size - offset < size) return INVALID_SIZE;
    if (size !== 0) {
      if (!source) throw new AokanaBpMemoryFault(0, 'Null indirect buffer source');
      pointerView(source, size);
      record.bytes!.set(source.bytes.subarray(source.offset, source.offset + size), offset);
    }
    return 0;
  }

  insertBuffer(
    address: number,
    offset: number,
    source: AokanaBpPointer | null,
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
    if (record.bytes) bytes?.set(record.bytes.subarray(0, offset));
    if (size !== 0) {
      if (!source) throw new AokanaBpMemoryFault(0, 'Null indirect buffer source');
      pointerView(source, size);
      bytes!.set(source.bytes.subarray(source.offset, source.offset + size), offset);
    }
    if (record.bytes) bytes?.set(record.bytes.subarray(offset), offset + size);
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
