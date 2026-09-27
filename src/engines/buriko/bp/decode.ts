import type {BurikoBpThread} from './state.js';
import {byteDataView} from '../../../core/binary.js';

function view(thread: BurikoBpThread): DataView {
  return byteDataView(thread.moduleMemory);
}

function readByte(memory: Uint8Array, pc: number): number {
  const byte = typeof pc === 'number' && pc >>> 0 === pc ? memory[pc] : undefined;
  // DataView retains ToIndex conversion and the original bounds/detachment faults.
  return byte === undefined ? byteDataView(memory).getUint8(pc) : byte;
}

export function fetchOpcode(thread: BurikoBpThread): number {
  const pc = thread.pc;
  thread.instructionStart = pc;
  thread.pc = (pc + 1) >>> 0;
  return readByte(thread.moduleMemory, pc);
}

export function readU8(thread: BurikoBpThread): number {
  const value = readByte(thread.moduleMemory, thread.pc);
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
  const memory = thread.moduleMemory;
  // Keep one fixed view when another agent can grow shared storage, or an offset
  // conversion can mutate it. Ordinary module bytes cannot resize mid-operand.
  const dataView =
    typeof pc === 'number' && memory.buffer instanceof ArrayBuffer ? null : view(thread);
  do {
    byte = dataView ? dataView.getUint8(pc) : readByte(memory, pc);
    pc = (pc + 1) >>> 0;
    value |= (byte & 0x7f) << (shift & 31);
    shift = (shift + 7) >>> 0;
  } while (byte & 0x80);
  // The native 64-bit sign mask contributes no low bits for shifts 32..63.
  // Guard before the JS shift, whose count would otherwise wrap modulo 32.
  const signShift = shift & 63;
  if ((byte & 0x40) !== 0 && signShift < 32) value |= -1 << signShift;
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
  const memory = thread.moduleMemory;
  const dataView =
    typeof pc === 'number' && memory.buffer instanceof ArrayBuffer ? null : view(thread);
  do {
    byte = dataView ? dataView.getUint8(pc) : readByte(memory, pc);
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
  // The native 64-bit sign mask contributes no low bits for shifts 32..63.
  // Guard before the JS shift, whose count would otherwise wrap modulo 32.
  const signShift = shift & 63;
  if ((byte & 0x40) !== 0 && signShift < 32) value |= -1 << signShift;
  thread.pc = pc;
  return {type, value: value | 0};
}
