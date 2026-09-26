import type {BurikoBpOpcodeContext, BurikoBpOpcodeHandler} from '../../native/types.js';
import {pop32, push32} from '../state.js';
import {readI8, readU8, readVarInt} from '../decode.js';

/** 1400d0180: comparison/boolean helper. Bit operations return the bit result. */
export function compare32(operation: number, left: number, right: number): number {
  const a = left | 0,
    b = right | 0;
  switch (operation) {
    case 0:
      return Number(a === b);
    case 1:
      return Number(a !== b);
    case 2:
      return Number(a < b);
    case 3:
      return Number(a <= b);
    case 4:
      return Number(a >= b);
    case 5:
      return Number(a > b);
    case 6:
      return a & b;
    case 7:
      return a | b;
    case 8:
      return Number(a !== 0 && b !== 0);
    case 9:
      return Number(a !== 0 || b !== 0);
    default:
      return 0;
  }
}

/** 1400d0230, 1400cf3d0 and 1400cf380 widen signed division to 64 bits. */
export function arithmetic32(operation: number, left: number, right: number): number {
  const a = left | 0,
    b = right | 0;
  switch (operation) {
    case 0:
      return (a + b) | 0;
    case 1:
      return (a - b) | 0;
    case 2:
      return Math.imul(a, b);
    case 3:
      return b === 0 ? -0x80000000 : Math.trunc(a / b) | 0;
    case 4:
      return b === 0 ? -0x80000000 : (a % b) | 0;
    case 5:
      return a & b;
    case 6:
      return a | b;
    case 7:
      return a ^ b;
    case 8:
      return a << b;
    case 9:
      return a >>> b;
    case 10:
      return a >> b;
    default:
      return -0x80000000;
  }
}

export function signedShift(value: number, count: number): number {
  return count < 0 ? value >> -count : value << count;
}

function binary(fn: (a: number, b: number) => number): BurikoBpOpcodeHandler {
  return (h) => {
    const right = pop32(h.thread),
      left = pop32(h.thread);
    push32(h.thread, fn(left, right));
    return 0;
  };
}

function immediate(h: BurikoBpOpcodeContext, operation: number): 0 {
  const right = readVarInt(h.thread),
    left = pop32(h.thread);
  push32(h.thread, arithmetic32(operation, left, right));
  return 0;
}

export const integerOpcodes: Readonly<Record<number, BurikoBpOpcodeHandler>> = {
  0x20: binary((a, b) => arithmetic32(0, a, b)),
  0x21: binary((a, b) => arithmetic32(1, a, b)),
  0x22: binary((a, b) => arithmetic32(2, a, b)),
  0x23: binary((a, b) => arithmetic32(3, a, b)),
  0x24: binary((a, b) => arithmetic32(4, a, b)),
  0x25: binary((a, b) => a & b),
  0x26: binary((a, b) => a | b),
  0x27: binary((a, b) => a ^ b),
  0x28: (h) => {
    push32(h.thread, ~pop32(h.thread));
    return 0;
  },
  0x29: binary((a, b) => a << b),
  0x2a: binary((a, b) => a >>> b),
  0x2b: binary((a, b) => a >> b),
  0x2c: (h) => immediate(h, 0),
  0x2d: (h) => immediate(h, 2),
  0x2e: (h) => {
    const multiplier = readVarInt(h.thread),
      value = pop32(h.thread),
      base = pop32(h.thread);
    push32(h.thread, Math.imul(value, multiplier) + base);
    return 0;
  },
  0x2f: (h) => immediate(h, 3),
  0x30: binary((a, b) => compare32(0, a, b)),
  0x31: binary((a, b) => compare32(1, a, b)),
  0x32: binary((a, b) => compare32(3, a, b)),
  0x33: binary((a, b) => compare32(4, a, b)),
  0x34: binary((a, b) => compare32(2, a, b)),
  0x35: binary((a, b) => compare32(5, a, b)),
  0x36: (h) => {
    const operation = readU8(h.thread),
      right = readVarInt(h.thread),
      left = pop32(h.thread);
    push32(h.thread, compare32(operation, left, right));
    return 0;
  },
  0x38: binary((a, b) => Number(a !== 0 && b !== 0)),
  0x39: binary((a, b) => Number(a !== 0 || b !== 0)),
  0x3a: (h) => {
    push32(h.thread, Number(pop32(h.thread) === 0));
    return 0;
  },
  0x3c: (h) => {
    const count = readI8(h.thread);
    push32(h.thread, signedShift(pop32(h.thread), count));
    return 0;
  },
  0x40: (h) => {
    const ifFalse = pop32(h.thread),
      ifTrue = pop32(h.thread),
      condition = pop32(h.thread);
    push32(h.thread, condition === 0 ? ifFalse : ifTrue);
    return 0;
  },
  0x42: (h) => {
    const divisor = BigInt(pop32(h.thread) | 0),
      multiplier = BigInt(pop32(h.thread) | 0),
      value = BigInt(pop32(h.thread) | 0);
    push32(
      h.thread,
      divisor === 0n ? 0x80000000 : Number(BigInt.asUintN(32, (value * multiplier) / divisor)),
    );
    return 0;
  },
  0x56: (h) => {
    const right = BigInt(pop32(h.thread) | 0),
      left = BigInt(pop32(h.thread) | 0);
    push32(h.thread, Number(BigInt.asUintN(32, (left * right) >> 16n)));
    return 0;
  },
  0x73: (h) => {
    pop32(h.thread);
    return 0;
  },
};
