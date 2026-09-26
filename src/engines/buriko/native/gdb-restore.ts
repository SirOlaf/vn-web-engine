import {clearIndeterminateMemory, copyMemoryBytes} from '../../../core/indeterminate-memory.js';
import {decodeSdc} from '../../../formats/buriko/compressed-resource.js';
import {pointerView, type BurikoBpPointer} from '../bp/memory.js';
import type {BurikoNamedBitArrays} from './named-bit-arrays.js';
import type {BurikoStringLists} from './string-lists.js';
import {textLength} from './text.js';

const INVALID_GDB = 0x80000002;
const GDB_SIGNATURE = new TextEncoder().encode('BURIKO GDB 3.00\0');
const RESERVED_STRING_LIST = 0x80000000;

function offset(pointer: BurikoBpPointer, amount: number): BurikoBpPointer {
  return {bytes: pointer.bytes, offset: pointer.offset + amount};
}

function copyAndZero(
  destination: BurikoBpPointer | null,
  source: BurikoBpPointer,
  stored: number,
  capacity: number,
): void {
  if (destination === null) return;
  const input = pointerView(source, stored),
    output = pointerView(destination, stored);
  copyMemoryBytes(
    new Uint8Array(output.buffer, output.byteOffset, output.byteLength),
    0,
    new Uint8Array(input.buffer, input.byteOffset, input.byteLength),
    0,
    stored,
  );
  if (stored < capacity) {
    const remainder = pointerView(offset(destination, stored), capacity - stored);
    new Uint8Array(remainder.buffer, remainder.byteOffset, remainder.byteLength).fill(0);
    clearIndeterminateMemory(destination.bytes, destination.offset + stored, capacity - stored);
  }
}

/** C13C0 restores the two caller-selected regions and the shared GDB registries. */
export class BurikoGdbRestore {
  constructor(
    private readonly strings: BurikoStringLists,
    private readonly bits: BurikoNamedBitArrays,
  ) {}

  restore(
    firstDestination: BurikoBpPointer | null,
    firstCapacity: BurikoBpPointer | null,
    secondDestination: BurikoBpPointer | null,
    secondCapacity: BurikoBpPointer | null,
    source: BurikoBpPointer,
  ): 0 | 0x80000002 {
    const encoded = source.bytes.subarray(source.offset).slice();
    let decoded: Uint8Array;
    try {
      decoded = decodeSdc(encoded);
    } catch (error) {
      if (error instanceof Error) return INVALID_GDB;
      throw error;
    }
    if (decoded.byteLength < 0x20) return INVALID_GDB;
    for (let index = 0; index < GDB_SIGNATURE.byteLength; index++)
      if (decoded[index] !== GDB_SIGNATURE[index]) return INVALID_GDB;
    const view = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength);
    if (view.getUint32(0x10, true) !== decoded.byteLength) return INVALID_GDB;

    let cursor = 0x1c;
    const firstStored = view.getUint32(cursor, true);
    cursor += 4;
    copyAndZero(firstDestination, {bytes: decoded, offset: cursor}, firstStored, 0x400);
    pointerView(firstCapacity!, 4).setUint32(0, 0x400, true);
    cursor += firstStored;

    const secondStored = view.getUint32(cursor, true);
    cursor += 4;
    copyAndZero(secondDestination, {bytes: decoded, offset: cursor}, secondStored, 0x100000);
    pointerView(secondCapacity!, 4).setUint32(0, 0x100000, true);
    cursor += secondStored;

    const stringCount = view.getUint32(cursor, true);
    cursor += 4;
    const appendStrings = (stringCount | 0) > 0;
    if (appendStrings) this.strings.append(RESERVED_STRING_LIST, null);
    for (let index = 0; index < stringCount; index++) {
      const value = {bytes: decoded, offset: cursor};
      if (appendStrings) this.strings.append(RESERVED_STRING_LIST, value);
      cursor += textLength(value) + 1;
    }
    this.bits.mergePacked({bytes: decoded, offset: cursor});
    return 0;
  }
}
