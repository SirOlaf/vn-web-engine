import {pointerView, type AokanaBpPointer} from '../bp/memory.js';

/** Codec-local private heap validity; ordinary BP pointers have no extra metadata. */
export interface AokanaCodecPointer extends AokanaBpPointer {
  readonly initialized?: Uint8Array;
}
export function codecView(
  pointer: AokanaCodecPointer | null,
  offset: number,
  length: number,
  read = true,
): DataView {
  if (pointer === null) throw new Error('Aokana codec accesses a null pointer');
  const at = pointer.offset + offset,
    view = pointerView({bytes: pointer.bytes, offset: at}, length);
  if (pointer.initialized !== undefined) {
    pointerView({bytes: pointer.initialized, offset: at}, length);
    if (read)
      for (let index = at; index < at + length; index++)
        if (pointer.initialized[index] === 0)
          throw new Error('Aokana codec reads unwritten private storage');
  }
  return view;
}
export function codecMark(pointer: AokanaCodecPointer, offset: number, length: number): void {
  pointer.initialized?.fill(1, pointer.offset + offset, pointer.offset + offset + length);
}
export function codecWrite(
  pointer: AokanaCodecPointer | null,
  offset: number,
  value: number,
): void {
  codecView(pointer, offset, 1, false).setUint8(0, value);
  codecMark(pointer!, offset, 1);
}
export function codecCopy(
  destination: AokanaCodecPointer | null,
  output: number,
  source: AokanaCodecPointer | null,
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
