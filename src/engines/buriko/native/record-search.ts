import {pointerView, type BurikoBpPointer} from '../bp/memory.js';

export type BurikoRecordPredicateFormat =
  {result: 0; size: number; tag: number} | {result: 0x80000008};

/** F9AE0 (and size-only thunk F9AD0): the tag is signed low WORD; raw size is high WORD. */
export function decodeBurikoRecordPredicateFormat(format: number): BurikoRecordPredicateFormat {
  const tag = (format << 16) >> 16,
    size = tag === -1 ? format >>> 16 : 1 << (tag & 3);
  return size === 0 ? {result: 0x80000008} : {result: 0, size, tag};
}

function required(pointer: BurikoBpPointer | null): BurikoBpPointer {
  if (pointer === null)
    throw new RangeError('Buriko record predicate consumed a null native pointer');
  return pointer;
}
function at(pointer: BurikoBpPointer | null, bytes: number): BurikoBpPointer | null {
  return pointer === null ? null : {bytes: pointer.bytes, offset: pointer.offset + bytes};
}
function copiedScalar(pointer: BurikoBpPointer | null, size: number): bigint {
  const input = pointerView(required(pointer), size);
  let result = 0n;
  for (let index = 0; index < size; index++)
    result |= BigInt(input.getUint8(index)) << BigInt(index * 8);
  return result;
}

/** F9890 preserves independent zero-filled QWORD copies and the native asymmetric signed comparison. */
export function matchesBurikoRecordPredicate(
  record: BurikoBpPointer | null,
  comparison: BurikoBpPointer | null,
  format: number,
  operation: number,
  flags: number,
): boolean {
  const decoded = decodeBurikoRecordPredicateFormat(format);
  if (decoded.result !== 0) return false;
  const {size, tag} = decoded;
  let left = 0n,
    right = 0n;
  if (tag !== -1) {
    left = copiedScalar(record, size);
    right = copiedScalar(comparison, size);
    if ((flags & 1) !== 0 && left === 0n) return false;
  }
  operation >>>= 0;
  if (operation < 2) {
    // Equality reads the original spans again after the scalar locals were copied.
    const a = pointerView(required(record), size),
      b = pointerView(required(comparison), size);
    let equal = true;
    for (let index = 0; index < size; index++)
      if (a.getUint8(index) !== b.getUint8(index)) {
        equal = false;
        break;
      }
    return operation === 0 ? equal : !equal;
  }
  if (operation === 2 || operation === 3) {
    if (tag !== -1) return operation === 2 ? (left & right) === 0n : (left & right) !== 0n;
    const a = pointerView(required(record), size),
      b = pointerView(required(comparison), size);
    for (let index = 0; index < size; index++)
      if ((a.getUint8(index) & b.getUint8(index)) !== 0) return operation === 3;
    return operation === 2;
  }
  if (tag >= 4 && tag <= 6) left = BigInt.asIntN(size * 8, left);
  else if (tag < 0 || tag > 2) return false;
  // The comparison remains zero-extended even for signed byte/WORD/DWORD tags.
  switch (operation) {
    case 4:
      return left < right;
    case 5:
      return left <= right;
    case 6:
      return left > right;
    case 7:
      return left >= right;
    default:
      return false;
  }
}

/** F9B40: decode before traversal; advance pointers by zero-extended DWORD stride. */
export function findBurikoMatchingRecord(
  source: BurikoBpPointer | null,
  count: number,
  stride: number,
  comparison: BurikoBpPointer | null,
  format: number,
  options: number,
): number {
  count >>>= 0;
  stride >>>= 0;
  const decoded = decodeBurikoRecordPredicateFormat(format);
  if (decoded.result !== 0 || decoded.size > stride) return 0xffffffff;
  let record = source;
  for (let index = 0; index < count; index = (index + 1) >>> 0) {
    if (matchesBurikoRecordPredicate(record, comparison, format, options & 0xffff, options >>> 16))
      return index;
    record = at(record, stride);
  }
  return 0xffffffff;
}

/** F9C30 writes each match immediately; both input and comparison are read anew next iteration. */
export function writeBurikoMatchingRecordIndices(
  output: BurikoBpPointer | null,
  source: BurikoBpPointer | null,
  count: number,
  stride: number,
  comparison: BurikoBpPointer | null,
  format: number,
  options: number,
): number {
  count >>>= 0;
  stride >>>= 0;
  const decoded = decodeBurikoRecordPredicateFormat(format);
  if (decoded.result !== 0 || decoded.size > stride) return 0;
  let record = source,
    written = 0;
  for (let index = 0; index < count; index = (index + 1) >>> 0) {
    if (
      matchesBurikoRecordPredicate(record, comparison, format, options & 0xffff, options >>> 16)
    ) {
      pointerView(required(at(output, written * 4)), 4).setUint32(0, index, true);
      written = (written + 1) >>> 0;
    }
    record = at(record, stride);
  }
  return written;
}
