import type {AokanaBpOpcodeContext, AokanaBpOpcodeHandler} from '../../native/types.js';
import type {AokanaBpPointer} from '../memory.js';
import {pop32, push32} from '../state.js';
import {pointer, pointerBytes} from './operands.js';
import {
  aokanaRosettaSseReciprocal,
  aokanaRosettaSseReciprocalSqrt,
} from '../../native/cpu-numerical-profile.js';

const f = Math.fround;

/** CVTPS2DQ under the native SSE2 baseline profile: nearest, ties to even. */
export function roundToInt32(value: number): number {
  if (!Number.isFinite(value)) return -0x80000000;
  const below = Math.floor(value),
    fraction = value - below;
  const rounded = fraction > 0.5 || (fraction === 0.5 && below % 2 !== 0) ? below + 1 : below;
  return rounded < -0x80000000 || rounded > 0x7fffffff ? -0x80000000 : rounded;
}

/** Native fixed result snaps fractions strictly below 64 or above 65472. */
export function fixedResult(value: number): number {
  const raw = roundToInt32(f(value * 65536));
  const integral = raw & 0xffff0000,
    fraction = (raw - integral) | 0;
  if (fraction < 64) return integral;
  if (fraction > 65472) return (integral + 65536) | 0;
  return raw;
}

function fixedFloat(value: number): number {
  return f(f(value | 0) * (1 / 65536));
}

/**
 * The measured CPU profile supplies the native approximate reciprocal seed;
 * every Newton-refinement operation still rounds independently to f32.
 * All nonzero fixed32 inputs here are normal, as are their reciprocals.
 */
export function refinedReciprocal(denominator: number): number {
  const seed = aokanaRosettaSseReciprocal(denominator);
  return f(f(seed + seed) - f(f(seed * seed) * denominator));
}

export function divideFixed(numerator: number, denominator: number): number {
  if ((denominator | 0) === 0) return 0;
  return fixedResult(f(refinedReciprocal(fixedFloat(denominator)) * fixedFloat(numerator)));
}

function view(p: AokanaBpPointer, size: number, offset = 0): DataView {
  const bytes = pointerBytes(p, size, offset);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readVector(p: AokanaBpPointer): number[] {
  const v = view(p, 16);
  return [v.getInt32(0, true), v.getInt32(4, true), v.getInt32(8, true), v.getInt32(12, true)];
}

function writeVector(p: AokanaBpPointer, values: readonly number[]): void {
  const v = view(p, 16);
  for (let i = 0; i < 4; i++) v.setInt32(i * 4, values[i]!, true);
}

function integer64(h: AokanaBpOpcodeContext, operation: number): 0 {
  const right = pointer(h, pop32(h.thread)),
    left = pointer(h, pop32(h.thread)),
    destination = pointer(h, pop32(h.thread));
  const b = view(right, 8).getBigInt64(0, true);
  // Opcode53's zero-divisor branch does not load the dividend.
  const a = operation === 3 && b === 0n ? 0n : view(left, 8).getBigInt64(0, true);
  let result: bigint;
  if (operation === 0) result = a + b;
  else if (operation === 1) result = a - b;
  else if (operation === 2) result = a * b;
  else if (operation === 3 && b === 0n) result = -(1n << 63n);
  else {
    if (b === 0n || (a === -(1n << 63n) && b === -1n))
      throw new Error('Aokana ._bp native 64-bit division fault');
    result = operation === 3 ? a / b : a % b;
  }
  view(destination, 8).setBigInt64(0, BigInt.asIntN(64, result), true);
  return 0;
}

export const fixedOpcodes: Readonly<Record<number, AokanaBpOpcodeHandler>> = {
  0x46: (h) => {
    const denominator = pop32(h.thread) | 0,
      numerator = pop32(h.thread) | 0,
      end = pop32(h.thread) | 0,
      start = pop32(h.thread) | 0;
    const ratio = denominator === 0 ? 0 : f(f(numerator) / f(denominator));
    const clamped = ratio < 0 ? 0 : Math.min(1, ratio);
    push32(h.thread, fixedResult(f(f(f(f(end) - f(start)) * clamped) + f(start))));
    return 0;
  },
  0x47: (h) => {
    const ratio = fixedFloat(pop32(h.thread)),
      end = fixedFloat(pop32(h.thread)),
      start = fixedFloat(pop32(h.thread));
    const clamped = ratio < 0 ? 0 : Math.min(1, ratio);
    push32(h.thread, fixedResult(f(f(f(end - start) * clamped) + start)));
    return 0;
  },
  0x50: (h) => integer64(h, 0),
  0x51: (h) => integer64(h, 1),
  0x52: (h) => integer64(h, 2),
  0x53: (h) => integer64(h, 3),
  0x54: (h) => integer64(h, 4),
  0x57: (h) => {
    const divisor = pop32(h.thread),
      value = pop32(h.thread);
    push32(h.thread, divideFixed(value, divisor));
    return 0;
  },
  0x58: (h) => {
    const right = pointer(h, pop32(h.thread)),
      left = pointer(h, pop32(h.thread)),
      destination = pointer(h, pop32(h.thread));
    const a = readVector(left),
      b = readVector(right);
    writeVector(
      destination,
      a.map((value, i) => (value + b[i]!) | 0),
    );
    return 0;
  },
  0x59: (h) => {
    const right = pointer(h, pop32(h.thread)),
      left = pointer(h, pop32(h.thread)),
      destination = pointer(h, pop32(h.thread));
    const a = readVector(left),
      b = readVector(right);
    writeVector(
      destination,
      a.map((value, i) => (value - b[i]!) | 0),
    );
    return 0;
  },
  0x5a: (h) => {
    const right = pointer(h, pop32(h.thread)),
      left = pointer(h, pop32(h.thread)),
      destination = pointer(h, pop32(h.thread));
    // Native scalar stores are interleaved with reads; overlapping vectors matter.
    for (let i = 0; i < 4; i++) {
      const a = view(left, 4, i * 4).getInt32(0, true),
        b = view(right, 4, i * 4).getInt32(0, true);
      view(destination, 4, i * 4).setInt32(
        0,
        Number(BigInt.asIntN(32, (BigInt(a) * BigInt(b)) >> 16n)),
        true,
      );
    }
    return 0;
  },
  0x5b: (h) => {
    const right = pointer(h, pop32(h.thread)),
      left = pointer(h, pop32(h.thread)),
      destination = pointer(h, pop32(h.thread));
    const b = readVector(right),
      a = readVector(left);
    writeVector(
      destination,
      a.map((value, i) => divideFixed(value, b[i]!)),
    );
    return 0;
  },
  0x5d: (h) => {
    const source = pointer(h, pop32(h.thread)),
      destination = pointer(h, pop32(h.thread));
    const input = readVector(source).map(fixedFloat);
    const x = input[0]!,
      y = input[1]!,
      z = input[2]!;
    // ADDSS order is x² + (y² + z²), not a left-to-right reduction.
    const square = f(f(x * x) + f(f(y * y) + f(z * z)));
    let result = [0, 0, 0, 0];
    if (square > 0) {
      const seed = aokanaRosettaSseReciprocalSqrt(square);
      const correction = f(f(f(f(square * seed) * seed) * seed) * -0.5);
      const inverse = f(f(seed * 1.5) + correction);
      result = [f(inverse * x), f(inverse * y), f(inverse * z), f(square * inverse)].map(
        fixedResult,
      );
    }
    writeVector(destination, result);
    return 0;
  },
  0x5e: (h) => {
    const multiplier = BigInt(pop32(h.thread) | 0),
      source = pointer(h, pop32(h.thread)),
      destination = pointer(h, pop32(h.thread));
    for (let i = 0; i < 4; i++) {
      const value = view(source, 4, i * 4).getInt32(0, true);
      view(destination, 4, i * 4).setInt32(
        0,
        Number(BigInt.asIntN(32, (BigInt(value) * multiplier) >> 16n)),
        true,
      );
    }
    return 0;
  },
  0x5f: (h) => {
    const divisor = pop32(h.thread),
      source = pointer(h, pop32(h.thread)),
      destination = pointer(h, pop32(h.thread));
    const result =
      divisor === 0 ? [0, 0, 0, 0] : readVector(source).map((value) => divideFixed(value, divisor));
    writeVector(destination, result);
    return 0;
  },
};
