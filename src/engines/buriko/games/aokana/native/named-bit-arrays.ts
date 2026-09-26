import type {AokanaBpPointer} from '../bp/memory.js';
import {pointerView} from '../bp/memory.js';
import {aokanaCompareNamedBytes, aokanaNamedValueHash} from './named-value-map.js';
import {textBytes, textLength} from './text.js';

interface NamedBitArray {
  readonly hash: number;
  readonly name: AokanaBpPointer;
  bitCount: number;
  data: Uint8Array;
  next: NamedBitArray | null;
}

export interface AokanaNamedBitArraySnapshot {
  readonly name: Uint8Array;
  readonly bitCount: number;
  readonly data: Uint8Array;
}

/** 08D6F0 uses wrapping DWORD addition before rounding the bit count. */
export function aokanaNamedBitByteCount(bitCount: number): number {
  return ((bitCount + 7) >>> 0) >>> 3;
}

/** 08D6E0 selects the packed byte; 08D6C0 selects its MSB-first bit mask. */
function namedBitByteIndex(bitIndex: number): number {
  return bitIndex >>> 3;
}
function namedBitMask(bitIndex: number): number {
  return 0x80 >> (bitIndex & 7);
}

/** The one named-bit registry shared by Bank 80, GDB restore, startup and save. */
export class AokanaNamedBitArrays {
  private first: NamedBitArray | null = null;

  /** 08CD60 hashes signed bytes, compares unsigned name bytes, and moves a match to the front. */
  private findMoveToFront(name: AokanaBpPointer): NamedBitArray | null {
    const hash = aokanaNamedValueHash(name);
    let previous: NamedBitArray | null = null,
      entry = this.first;
    while (entry !== null) {
      if (entry.hash === hash && aokanaCompareNamedBytes(name, entry.name) === 0) {
        if (previous !== null) {
          previous.next = entry.next;
          entry.next = this.first;
          this.first = entry;
        }
        return entry;
      }
      previous = entry;
      entry = entry.next;
    }
    return null;
  }

  /** 08D4E0 creates a newest entry or reallocates the exact new rounded size. */
  createOrResize(name: AokanaBpPointer, bitCount: number): 0 | 0x80000001 {
    bitCount >>>= 0;
    const byteCount = aokanaNamedBitByteCount(bitCount);
    if (byteCount === 0) return 0x80000001;
    const entry = this.findMoveToFront(name);
    if (entry === null) {
      const copiedName = textBytes(name, true).slice();
      this.first = {
        hash: aokanaNamedValueHash(name),
        name: {bytes: copiedName, offset: 0},
        bitCount,
        data: new Uint8Array(byteCount),
        next: this.first,
      };
      return 0;
    }
    const resized = new Uint8Array(byteCount);
    resized.set(entry.data.subarray(0, Math.min(entry.data.byteLength, byteCount)));
    entry.bitCount = bitCount;
    entry.data = resized;
    return 0;
  }

  /** 08D3D0 writes one MSB-first bit after shared move-to-front lookup. */
  writeBit(name: AokanaBpPointer | null, bitIndex: number, value: number): number {
    const entry = this.findMoveToFront(name!);
    if (entry === null) return 0x80000002;
    bitIndex >>>= 0;
    value >>>= 0;
    if (bitIndex >= entry.bitCount) return 0x80000003;
    const byteIndex = namedBitByteIndex(bitIndex),
      mask = namedBitMask(bitIndex);
    entry.data[byteIndex] =
      value !== 0 ? entry.data[byteIndex]! | mask : entry.data[byteIndex]! & ~mask;
    return 0;
  }

  /** 08D2E0 preserves the native count cap, wrapping end, and empty wrapped span. */
  writeRange(name: AokanaBpPointer | null, start: number, value: number, count: number): number {
    const entry = this.findMoveToFront(name!);
    if (entry === null) return 0x80000002;
    start >>>= 0;
    value >>>= 0;
    count >>>= 0;
    if (start >= entry.bitCount) return 0x80000003;
    if ((count - 1) >>> 0 > 0xffff) return 0x80000004;
    const end = (start + count) >>> 0;
    if (end > entry.bitCount) return 0x80000004;
    for (let bitIndex = start; bitIndex < end; bitIndex++) {
      const byteIndex = namedBitByteIndex(bitIndex),
        mask = namedBitMask(bitIndex);
      entry.data[byteIndex] =
        value !== 0 ? entry.data[byteIndex]! | mask : entry.data[byteIndex]! & ~mask;
    }
    return 0;
  }

  /** 08D250 writes exactly one DWORD only after name and unsigned-index validation. */
  readBit(output: AokanaBpPointer | null, name: AokanaBpPointer | null, bitIndex: number): number {
    const entry = this.findMoveToFront(name!);
    if (entry === null) return 0x80000002;
    bitIndex >>>= 0;
    if (bitIndex >= entry.bitCount) return 0x80000003;
    const value = Number((entry.data[namedBitByteIndex(bitIndex)]! & namedBitMask(bitIndex)) !== 0);
    pointerView(output!, 4).setUint32(0, value, true);
    return 0;
  }

  /** 08D460 applies create/resize first, then replaces every rounded data byte. */
  replaceData(name: AokanaBpPointer, bitCount: number, data: AokanaBpPointer): 0 | 0x80000001 {
    const result = this.createOrResize(name, bitCount);
    if (result !== 0) return result;
    const entry = this.findMoveToFront(name)!,
      byteCount = aokanaNamedBitByteCount(bitCount),
      source = pointerView(data, byteCount);
    entry.data.set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
    return 0;
  }

  private packedRecords(source: AokanaBpPointer) {
    const count = pointerView(source, 4).getUint32(0, true),
      records: Array<{
        readonly name: AokanaBpPointer;
        readonly bitCount: number;
        readonly data: AokanaBpPointer;
      }> = [];
    let offset = 4;
    for (let index = 0; index < count; index++) {
      const name = {bytes: source.bytes, offset: source.offset + offset};
      offset += textLength(name) + 1;
      const bitCount = pointerView(
        {bytes: source.bytes, offset: source.offset + offset},
        4,
      ).getUint32(0, true);
      offset += 4;
      const data = {bytes: source.bytes, offset: source.offset + offset};
      offset += aokanaNamedBitByteCount(bitCount);
      records.push({name, bitCount, data});
    }
    return records;
  }

  /** 08CFE0 scans first, then replaces records in reverse to retain their linked order. */
  replacePacked(source: AokanaBpPointer): 0 {
    const records = this.packedRecords(source);
    for (let i = records.length - 1; i >= 0; i--) {
      const record = records[i]!;
      this.replaceData(record.name, record.bitCount, record.data);
    }
    return 0;
  }

  /** 08D150 measures or copies the current linked order without move-to-front lookup. */
  copyPacked(output: AokanaBpPointer | null): number {
    let size = 4,
      count = 0;
    for (let entry = this.first; entry !== null; entry = entry.next) {
      const name = textBytes(entry.name, true),
        length = aokanaNamedBitByteCount(entry.bitCount);
      if (output !== null) {
        const target = pointerView(
          {bytes: output.bytes, offset: output.offset + size},
          name.length + 4 + length,
        );
        new Uint8Array(target.buffer, target.byteOffset, name.length).set(name);
        target.setUint32(name.length, entry.bitCount, true);
        new Uint8Array(target.buffer, target.byteOffset + name.length + 4, length).set(entry.data);
      }
      size = (size + name.length + 4 + length) >>> 0;
      count = (count + 1) >>> 0;
    }
    if (output !== null) pointerView(output, 4).setUint32(0, count, true);
    return size;
  }

  /** 08CDE0 scans packed records once, then publishes and OR-merges them in reverse. */
  mergePacked(source: AokanaBpPointer): 0 {
    const records = this.packedRecords(source);
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index]!,
        existing = this.findMoveToFront(record.name);
      if (existing === null) {
        this.replaceData(record.name, record.bitCount, record.data);
        continue;
      }
      const bitCount = Math.max(existing.bitCount, record.bitCount) >>> 0;
      this.createOrResize(record.name, bitCount);
      const resized = this.findMoveToFront(record.name)!,
        byteCount = aokanaNamedBitByteCount(record.bitCount),
        saved = pointerView(record.data, byteCount);
      for (let byte = 0; byte < byteCount; byte++)
        resized.data[byte] = resized.data[byte]! | saved.getUint8(byte);
    }
    return 0;
  }

  /** Copying snapshots expose shared state without lending out registry-owned storage. */
  read(name: AokanaBpPointer): AokanaNamedBitArraySnapshot | null {
    const entry = this.findMoveToFront(name);
    return entry === null
      ? null
      : {
          name: textBytes(entry.name, true).slice(),
          bitCount: entry.bitCount,
          data: entry.data.slice(),
        };
  }

  snapshots(): AokanaNamedBitArraySnapshot[] {
    const result: AokanaNamedBitArraySnapshot[] = [];
    for (let entry = this.first; entry !== null; entry = entry.next)
      result.push({
        name: textBytes(entry.name, true).slice(),
        bitCount: entry.bitCount,
        data: entry.data.slice(),
      });
    return result;
  }

  clear(): void {
    this.first = null;
  }
}
