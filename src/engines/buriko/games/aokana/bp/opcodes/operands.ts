import type {AokanaBpOpcodeContext} from '../../native/types.js';
import type {AokanaBpPointer} from '../memory.js';
import {readU16} from '../decode.js';

/** Packed access selectors use signed byte for every selector except 1 and 2. */
export function accessSize(type: number): number {
  return type === 2 ? 4 : type === 1 ? 2 : 1;
}

export function readScalar(h: AokanaBpOpcodeContext, address: number, type: number): number {
  return type === 2
    ? h.memory.readI32(h.thread, address >>> 0)
    : type === 1
      ? h.memory.readI16(h.thread, address >>> 0)
      : h.memory.readI8(h.thread, address >>> 0);
}

export function writeScalar(
  h: AokanaBpOpcodeContext,
  address: number,
  type: number,
  value: number,
): void {
  if (type === 2) h.memory.writeU32(h.thread, address >>> 0, value);
  else if (type === 1) h.memory.writeU16(h.thread, address >>> 0, value);
  else h.memory.writeU8(h.thread, address >>> 0, value);
}

export function localAddress(h: AokanaBpOpcodeContext, displacement: number): number {
  return ((h.thread.frameCursor - displacement) | 0x20000000) >>> 0;
}

export function localDescriptor(h: AokanaBpOpcodeContext): {address: number; type: number} {
  const descriptor = readU16(h.thread);
  return {address: localAddress(h, descriptor & 0x3fff), type: descriptor >>> 14};
}

export function pointer(h: AokanaBpOpcodeContext, address: number): AokanaBpPointer {
  const resolved = h.memory.resolve(h.thread, address >>> 0);
  if (resolved === null) throw new Error('Aokana ._bp null memory dereference');
  return resolved;
}

export function pointerBytes(p: AokanaBpPointer, size: number, displacement = 0): Uint8Array {
  const offset = p.offset + displacement;
  if (!Number.isSafeInteger(size) || size < 0 || offset < 0 || offset + size > p.bytes.length) {
    throw new Error('Aokana ._bp native memory access outside backing storage');
  }
  return p.bytes.subarray(offset, offset + size);
}

/** 1400135a0 is overlap-safe, including its short-copy cases. */
export function moveBytes(
  destination: AokanaBpPointer,
  source: AokanaBpPointer,
  size: number,
): void {
  const input = pointerBytes(source, size);
  pointerBytes(destination, size).set(input);
}
