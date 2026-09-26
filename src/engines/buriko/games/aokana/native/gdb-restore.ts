import {decodeSdc} from '../../../../../formats/buriko/compressed-resource.js';
import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import type {AokanaNamedBitArrays} from './named-bit-arrays.js';
import type {AokanaStringLists} from './string-lists.js';
import {textLength} from './text.js';

const INVALID_GDB = 0x80000002;
const GDB_SIGNATURE = new TextEncoder().encode('BURIKO GDB 3.00\0');
const RESERVED_STRING_LIST = 0x80000000;

function offset(pointer: AokanaBpPointer, amount: number): AokanaBpPointer {
  return {bytes: pointer.bytes, offset: pointer.offset + amount};
}

function copyAndZero(
  destination: AokanaBpPointer | null,
  source: AokanaBpPointer,
  stored: number,
  capacity: number,
): void {
  if (destination === null) return;
  const input = pointerView(source, stored),
    output = pointerView(destination, stored);
  new Uint8Array(output.buffer, output.byteOffset, output.byteLength).set(
    new Uint8Array(input.buffer, input.byteOffset, input.byteLength),
  );
  if (stored < capacity) {
    const remainder = pointerView(offset(destination, stored), capacity - stored);
    new Uint8Array(remainder.buffer, remainder.byteOffset, remainder.byteLength).fill(0);
  }
}

/** C13C0 restores the two caller-selected regions and the shared GDB registries. */
export class AokanaGdbRestore {
  constructor(
    private readonly strings: AokanaStringLists,
    private readonly bits: AokanaNamedBitArrays,
  ) {}

  restore(
    firstDestination: AokanaBpPointer | null,
    firstCapacity: AokanaBpPointer | null,
    secondDestination: AokanaBpPointer | null,
    secondCapacity: AokanaBpPointer | null,
    source: AokanaBpPointer,
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
