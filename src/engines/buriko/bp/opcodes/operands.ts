import type {BurikoBpOpcodeContext} from '../../native/types.js';
import type {BurikoBpPointer} from '../memory.js';
import {readU16} from '../decode.js';
import {
  markIndeterminateMemory,
  clearIndeterminateMemory,
  copyMemoryBytes,
  requireDeterminateMemory,
} from '../../../../core/indeterminate-memory.js';

/** Packed access selectors use signed byte for every selector except 1 and 2. */
export function accessSize(type: number): number {
  return type === 2 ? 4 : type === 1 ? 2 : 1;
}

export function readScalar(h: BurikoBpOpcodeContext, address: number, type: number): number {
  return type === 2
    ? h.memory.readI32(h.thread, address >>> 0)
    : type === 1
      ? h.memory.readI16(h.thread, address >>> 0)
      : h.memory.readI8(h.thread, address >>> 0);
}

export function writeScalar(
  h: BurikoBpOpcodeContext,
  address: number,
  type: number,
  value: number,
): void {
  if (type === 2) h.memory.writeU32(h.thread, address >>> 0, value);
  else if (type === 1) h.memory.writeU16(h.thread, address >>> 0, value);
  else h.memory.writeU8(h.thread, address >>> 0, value);
}

export function localAddress(h: BurikoBpOpcodeContext, displacement: number): number {
  return ((h.thread.frameCursor - displacement) | h.memory.abi.frameTag) >>> 0;
}

export function writeDeferredScalar(
  h: BurikoBpOpcodeContext,
  address: number,
  type: number,
  word: {value: number; reason?: string},
): void {
  if (word.reason === undefined) writeScalar(h, address, type, word.value);
  else {
    const target = h.memory.pointer(h.thread, address >>> 0, accessSize(type));
    markIndeterminateMemory(target.bytes, target.offset, accessSize(type), word.reason);
  }
}

export function localDescriptor(h: BurikoBpOpcodeContext): {address: number; type: number} {
  const descriptor = readU16(h.thread);
  return {address: localAddress(h, descriptor & 0x3fff), type: descriptor >>> 14};
}

export function pointer(h: BurikoBpOpcodeContext, address: number): BurikoBpPointer {
  const resolved = h.memory.resolve(h.thread, address >>> 0);
  if (resolved === null) throw new Error('Buriko ._bp null memory dereference');
  return resolved;
}

export function pointerBytes(
  p: BurikoBpPointer,
  size: number,
  displacement = 0,
  access: 'read' | 'write' | 'transport' = 'read',
): Uint8Array {
  const offset = p.offset + displacement;
  if (!Number.isSafeInteger(size) || size < 0 || offset < 0 || offset + size > p.bytes.length) {
    throw new Error('Buriko ._bp native memory access outside backing storage');
  }
  if (access === 'read') requireDeterminateMemory(p.bytes, offset, size);
  else if (access === 'write') clearIndeterminateMemory(p.bytes, offset, size);
  return p.bytes.subarray(offset, offset + size);
}

/** 1400135a0 is overlap-safe, including its short-copy cases. */
export function moveBytes(
  destination: BurikoBpPointer,
  source: BurikoBpPointer,
  size: number,
): void {
  const input = pointerBytes(source, size, 0, 'transport');
  const output = pointerBytes(destination, size, 0, 'transport');
  copyMemoryBytes(output, 0, input, 0, size);
}
