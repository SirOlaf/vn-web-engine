import {BurikoBpPointer, BurikoBpRegion, pointerView, hostPointer} from '../bp/memory.js';
import {byteDataView, indexOfZeroByte} from '../../../core/binary.js';
import {
  clearIndeterminateMemory,
  hasIndeterminateMemory,
  requireDeterminateMemory,
} from '../../../core/indeterminate-memory.js';

/** Codec-local private heap validity; ordinary BP pointers have no extra metadata. */
export interface BurikoCodecPointer extends BurikoBpPointer {
  readonly initialized?: Uint8Array;
}

/** Host-owned codec storage whose validity bitmap tracks which bytes the codec has written. */
export class BurikoCodecPrivatePointer extends BurikoBpPointer implements BurikoCodecPointer {
  constructor(
    region: BurikoBpRegion,
    offset: number,
    readonly initialized: Uint8Array,
  ) {
    super(region, offset);
  }

  override add(displacement: number): BurikoCodecPrivatePointer {
    return new BurikoCodecPrivatePointer(this.region, this.offset + displacement, this.initialized);
  }
}

export function codecPrivatePointer(
  bytes: Uint8Array,
  initialized: Uint8Array,
  offset = 0,
): BurikoCodecPrivatePointer {
  return new BurikoCodecPrivatePointer(new BurikoBpRegion(bytes), offset, initialized);
}
export function codecView(
  pointer: BurikoCodecPointer | null,
  offset: number,
  length: number,
  read = true,
): DataView {
  if (pointer === null) throw new Error('Buriko codec accesses a null pointer');
  const at = pointer.offset + offset,
    view = pointerView(new BurikoBpPointer(pointer.region, at), length);
  if (pointer.initialized !== undefined) {
    pointerView(hostPointer(pointer.initialized, at), length);
    if (read) {
      if (length >= 64) {
        if (indexOfZeroByte(pointer.initialized.subarray(at, at + length)) >= 0)
          throw new Error('Buriko codec reads unwritten private storage');
      } else
        for (let index = at; index < at + length; index++)
          if (pointer.initialized[index] === 0)
            throw new Error('Buriko codec reads unwritten private storage');
    }
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
  const at = pointer.offset + offset,
    bytes = pointer.view();
  if (
    !Number.isInteger(at) ||
    !Number.isInteger(length) ||
    at < 0 ||
    length < 0 ||
    at > bytes.byteLength ||
    at + length > bytes.byteLength
  )
    return null;
  if (pointer.initialized !== undefined) {
    if (at > pointer.initialized.byteLength || at + length > pointer.initialized.byteLength)
      return null;
    if (indexOfZeroByte(pointer.initialized.subarray(at, at + length)) >= 0) return null;
  }
  if (hasIndeterminateMemory(bytes, at, length)) return null;
  try {
    // Zero-length bounds checks alone cannot identify a detached validity bitmap.
    if (length === 0 && pointer.initialized !== undefined) byteDataView(pointer.initialized);
    return bytes.subarray(at, at + length);
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
  if (!Number.isInteger(at) || at < 0 || at >= pointer.region.size)
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
    bytes = pointer!.view(),
    value = byteDataView(bytes).getUint8(at);
  requireDeterminateMemory(bytes, at, 1);
  return value;
}

export function codecWrite(
  pointer: BurikoCodecPointer | null,
  offset: number,
  value: number,
): void {
  const at = codecByteOffset(pointer, offset, false),
    bytes = pointer!.view();
  byteDataView(bytes).setUint8(at, value);
  clearIndeterminateMemory(bytes, at, 1);
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
  destination!
    .view()
    .set(
      source!.view().subarray(source!.offset + input, source!.offset + input + count),
      destination!.offset + output,
    );
  codecMark(destination!, output, count);
}
