import type {BurikoBpThread} from './state.js';
import {byteDataView} from '../../../core/binary.js';

function view(thread: BurikoBpThread): DataView {
  return byteDataView(thread.moduleMemory);
}

export function fetchOpcode(thread: BurikoBpThread): number {
  const pc = thread.pc;
  thread.instructionStart = pc;
  thread.pc = (pc + 1) >>> 0;
  return view(thread).getUint8(pc);
}

export function readU8(thread: BurikoBpThread): number {
  const value = view(thread).getUint8(thread.pc);
  thread.pc = (thread.pc + 1) >>> 0;
  return value;
}

export function readI8(thread: BurikoBpThread): number {
  return (readU8(thread) << 24) >> 24;
}

export function readU16(thread: BurikoBpThread): number {
  const value = view(thread).getUint16(thread.pc, true);
  thread.pc = (thread.pc + 2) >>> 0;
  return value;
}

export function readI16(thread: BurikoBpThread): number {
  return (readU16(thread) << 16) >> 16;
}

export function readU32(thread: BurikoBpThread): number {
  const value = view(thread).getUint32(thread.pc, true);
  thread.pc = (thread.pc + 4) >>> 0;
  return value;
}

export function readI32(thread: BurikoBpThread): number {
  return readU32(thread) | 0;
}

export function readU64(thread: BurikoBpThread): bigint {
  const value = view(thread).getBigUint64(thread.pc, true);
  thread.pc = (thread.pc + 8) >>> 0;
  return value;
}

export function readI64(thread: BurikoBpThread): bigint {
  return BigInt.asIntN(64, readU64(thread));
}

/** Native payload shifts are 32-bit; terminal sign extension is a 64-bit shift. */
export function readVarInt(thread: BurikoBpThread): number {
  let pc = thread.pc;
  let value = 0;
  let shift = 0;
  let byte: number;
  const memory = view(thread);
  do {
    byte = memory.getUint8(pc);
    pc = (pc + 1) >>> 0;
    value |= (byte & 0x7f) << (shift & 31);
    shift = (shift + 7) >>> 0;
  } while (byte & 0x80);
  if (byte & 0x40) value |= Number(BigInt.asIntN(32, -1n << BigInt(shift & 63)));
  thread.pc = pc;
  return value | 0;
}

export function readTypedVarInt(thread: BurikoBpThread): {type: number; value: number} {
  let pc = thread.pc;
  let value = 0;
  let shift = 0;
  let type = 0;
  let first = true;
  let byte: number;
  const memory = view(thread);
  do {
    byte = memory.getUint8(pc);
    pc = (pc + 1) >>> 0;
    value |= (byte & 0x7f) << (shift & 31);
    shift = (shift + 7) >>> 0;
    if (first) {
      type = value & 3;
      value >>= 2;
      shift -= 2;
      first = false;
    }
  } while (byte & 0x80);
  if (byte & 0x40) value |= Number(BigInt.asIntN(32, -1n << BigInt(shift & 63)));
  thread.pc = pc;
  return {type, value: value | 0};
}
