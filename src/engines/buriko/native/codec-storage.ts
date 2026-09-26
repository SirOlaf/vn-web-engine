import {pointerView, type BurikoBpPointer} from '../bp/memory.js';
import {byteDataView} from '../../../core/binary.js';
import {
  clearIndeterminateMemory,
  hasIndeterminateMemory,
  requireDeterminateMemory,
} from '../../../core/indeterminate-memory.js';

/** Codec-local private heap validity; ordinary BP pointers have no extra metadata. */
export interface BurikoCodecPointer extends BurikoBpPointer {
  readonly initialized?: Uint8Array;
}
export function codecView(
  pointer: BurikoCodecPointer | null,
  offset: number,
  length: number,
  read = true,
): DataView {
  if (pointer === null) throw new Error('Buriko codec accesses a null pointer');
  const at = pointer.offset + offset,
    view = pointerView({bytes: pointer.bytes, offset: at}, length);
  if (pointer.initialized !== undefined) {
    pointerView({bytes: pointer.initialized, offset: at}, length);
    if (read)
      for (let index = at; index < at + length; index++)
        if (pointer.initialized[index] === 0)
          throw new Error('Buriko codec reads unwritten private storage');
  }
  return view;
}
export function codecMark(pointer: BurikoCodecPointer, offset: number, length: number): void {
  pointer.initialized?.fill(1, pointer.offset + offset, pointer.offset + offset + length);
}

/** Read-only fast path; reacquire after a host yield or an aliasing write.
 * A null result leaves fault timing to the ordinary byte access path. */
export function codecReadableSpan(
  pointer: BurikoCodecPointer | null,
  offset: number,
  length: number,
): Uint8Array | null {
  if (pointer === null) return null;
  const at = pointer.offset + offset;
  if (
    !Number.isInteger(at) ||
    !Number.isInteger(length) ||
    at < 0 ||
    length < 0 ||
    at > pointer.bytes.byteLength ||
    at + length > pointer.bytes.byteLength
  )
    return null;
  if (pointer.initialized !== undefined) {
    if (at > pointer.initialized.byteLength || at + length > pointer.initialized.byteLength)
      return null;
    for (let index = at; index < at + length; index++)
      if (pointer.initialized[index] === 0) return null;
  }
  if (hasIndeterminateMemory(pointer.bytes, at, length)) return null;
  try {
    // Zero-length bounds checks alone cannot identify a detached validity bitmap.
    if (length === 0 && pointer.initialized !== undefined) byteDataView(pointer.initialized);
    return pointer.bytes.subarray(at, at + length);
  } catch {
    return null;
  }
}

/** The one-byte pointerView checks, without allocating a view for every codec byte. */
function codecByteOffset(
  pointer: BurikoCodecPointer | null,
  offset: number,
  read: boolean,
): number {
  if (pointer === null) throw new Error('Buriko codec accesses a null pointer');
  const at = pointer.offset + offset;
  if (!Number.isInteger(at) || at < 0 || at >= pointer.bytes.byteLength)
    throw new RangeError('Buriko pointer exceeds its byte view');
  if (pointer.initialized !== undefined) {
    if (at >= pointer.initialized.byteLength)
      throw new RangeError('Buriko pointer exceeds its byte view');
    if (read && pointer.initialized[at] === 0)
      throw new Error('Buriko codec reads unwritten private storage');
  }
  return at;
}

export function codecRead(pointer: BurikoCodecPointer | null, offset: number): number {
  const at = codecByteOffset(pointer, offset, true),
    value = byteDataView(pointer!.bytes).getUint8(at);
  requireDeterminateMemory(pointer!.bytes, at, 1);
  return value;
}

export function codecWrite(
  pointer: BurikoCodecPointer | null,
  offset: number,
  value: number,
): void {
  const at = codecByteOffset(pointer, offset, false);
  byteDataView(pointer!.bytes).setUint8(at, value);
  clearIndeterminateMemory(pointer!.bytes, at, 1);
  if (pointer!.initialized !== undefined) pointer!.initialized[at] = 1;
}
export function codecCopy(
  destination: BurikoCodecPointer | null,
  output: number,
  source: BurikoCodecPointer | null,
  input: number,
  count: number,
): void {
  if (count === 0) return;
  codecView(source, input, count);
  codecView(destination, output, count, false);
  destination!.bytes.set(
    source!.bytes.subarray(source!.offset + input, source!.offset + input + count),
    destination!.offset + output,
  );
  codecMark(destination!, output, count);
}
