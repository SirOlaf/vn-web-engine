import {powReciprocalTable} from '../bp/opcodes/math-tables.js';
import type {AokanaCpuProfile} from './cpu-profile.js';
import type {AokanaNativeDisplayState} from './display-state.js';
import {aokanaStartupLogHigh, aokanaStartupLogLow} from './startup-math-tables.js';

const encoding = new DataView(new ArrayBuffer(8));
const numberFromBits = (bits: bigint): number => {
  encoding.setBigUint64(0, bits, true);
  return encoding.getFloat64(0, true);
};

/** 144d20's selected non-AVX SSE2 branch, restricted to positive DWORD CPU counts. */
export function aokanaStartupCpuLog(count: number): number {
  count >>>= 0;
  if (count === 0) throw new RangeError('Aokana startup requires a positive native CPU count');
  if (count === 1) return 0;
  encoding.setFloat64(0, count, true);
  const bits = encoding.getBigUint64(0, true),
    exponent = Number(bits >> 52n) - 1023,
    mantissa = bits & 0xfffffffffffffn;
  const index = Number((mantissa >> 44n) + ((mantissa >> 43n) & 1n));
  const normalized = numberFromBits(mantissa | 0x3fe0000000000000n),
    center = numberFromBits((BigInt(index) << 44n) | 0x3fe0000000000000n);
  const relative = (center - normalized) * powReciprocalTable[index]!,
    square = relative * relative,
    fourth = square * square;
  // Every operation is separately rounded binary64, in the native SSE2 order.
  const first = (relative * (1 / 3) + 0.5) * square + relative,
    second = ((relative * (1 / 6) + 0.2) * relative + 0.25) * fourth;
  const correction = exponent * 5.7699990475432854e-8 - (first + second),
    tail = aokanaStartupLogLow[index]! + correction,
    head = aokanaStartupLogHigh[index]! + exponent * 0.6931471228599548;
  return head + tail;
}

const divideUnsigned = (numerator: number, denominator: number): number => {
  denominator >>>= 0;
  if (denominator === 0) throw new RangeError('Aokana startup pixel-budget division by zero');
  return Math.trunc((numerator >>> 0) / denominator) >>> 0;
};

/** 0c6890, using the same CPU record as native80 0A and the current logical display mode. */
export function aokanaDisplayRenderPixelBudget(
  cpu: AokanaCpuProfile,
  display: AokanaNativeDisplayState,
): number {
  const firstCache = cpu.read(5) & 0xffff;
  if (firstCache >= 64) return divideUnsigned(Math.imul(firstCache, 0x18700), 1000);

  const count = cpu.read(9) >>> 0;
  const logarithm = aokanaStartupCpuLog(count) / aokanaStartupCpuLog(2);
  const exponent = Number(BigInt.asUintN(32, BigInt(Math.floor(logarithm))));
  const rowLimit = divideUnsigned(display.logicalHeight, Math.imul(8 - exponent, count));
  const width = display.logicalWidth >>> 0;
  let secondCache = cpu.read(6) & 0xffff;
  if (secondCache === 0) return 0x2800;
  if (cpu.read(9) >>> 0 <= 1)
    return Number(BigInt.asUintN(32, (BigInt(secondCache) * 0x727100n) / 100000n));

  const sharedCoreCount = cpu.firstCoreLogicalProcessorCount() >>> 0;
  if (sharedCoreCount >= 2) secondCache = divideUnsigned(secondCache, sharedCoreCount);
  const scaledCache = (secondCache << 10) >>> 2;
  const cacheRows =
    secondCache >= 256
      ? divideUnsigned(Math.imul(scaledCache, 0x125), Math.imul(width, 1000))
      : divideUnsigned(Math.imul(scaledCache, 0xc35), Math.imul(width, 10000));
  return Math.imul(Math.min(rowLimit, cacheRows), width) >>> 0;
}
