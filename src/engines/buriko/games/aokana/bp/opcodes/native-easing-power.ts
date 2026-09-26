import {
  reciprocalHigh,
  reciprocalLow,
  logHigh,
  logLow,
  expHigh,
  expLow,
} from './native-easing-power-tables.js';

export type NativeEasingExponent = 2 | 2.5 | 3 | 4 | 5 | 6;

const scratch = new DataView(new ArrayBuffer(8));
function fromWords(high: number, low = 0): number {
  scratch.setUint32(0, low, true);
  scratch.setUint32(4, high, true);
  return scratch.getFloat64(0, true);
}
function splitHigh(value: number): number {
  scratch.setFloat64(0, value, true);
  scratch.setUint32(0, scratch.getUint32(0, true) & 0xf8000000, true);
  return scratch.getFloat64(0, true);
}
const ln2High = fromWords(0x3fe62e42, 0xe0000000);
const ln2Low = fromWords(0x3e6efa39, 0xef35793c);
const inverseLn2Times64 = fromWords(0x40571547, 0x652b82fe);
const ln2Over64High = fromWords(0x3f862e42, 0xf0000000);
const negativeLn2Over64Low = fromWords(0xbdfdf473, 0xde6af278);
const sixth = fromWords(0x3fc55555, 0x55555555);
const third = fromWords(0x3fd55555, 0x55555555);
const fifth = fromWords(0x3fc99999, 0x9999999a);
const factorial4 = fromWords(0x3fa55555, 0x55555555);
const factorial5 = fromWords(0x3f811111, 0x11111111);
const factorial6 = fromWords(0x3f56c16c, 0x16c16c17);

/**
 * 140023710, non-AVX SSE2 with default nearest-even rounding, restricted to
 * signed-int32 bases and the six exponents used by 140056920.
 * Every arithmetic expression preserves an individual SSE2 rounding boundary.
 * After 0/±1 handling, |base| >= 2: the near-one and denormal log branches are
 * unreachable. 0 <= log(base)*power <= 186*ln(2), so exceptional exponential
 * scaling/underflow/overflow branches are unreachable too.
 */
export function nativeEasingPower(base: number, power: NativeEasingExponent): number {
  base |= 0;
  if (base < 0 && power === 2.5) return NaN;
  const negative = base < 0 && (power === 3 || power === 5);
  const magnitude = Math.abs(base);
  if (magnitude === 0) return 0;
  if (magnitude === 1) return negative ? -1 : 1;

  // 0237F5..0238B8: normalized significand and split reciprocal reduction.
  scratch.setFloat64(0, magnitude, true);
  const high = scratch.getUint32(4, true);
  const low = scratch.getUint32(0, true);
  const exponent = (high >>> 20) - 1023;
  const roundedMantissa = (high & 0xff000) + ((high & 0x800) << 1);
  const index = roundedMantissa >>> 12;
  const normalized = fromWords((high & 0xfffff) | 0x3fe00000, low);
  const center = fromWords(roundedMantissa | 0x3fe00000);
  const difference = center - normalized;
  const relativeHigh = difference * reciprocalHigh[index]!;
  const relativeLow = difference * reciprocalLow[index]!;
  const relative = relativeHigh + relativeLow;

  // 0238BC..023946: log1p polynomial and split log table accumulation.
  const square = relative * relative;
  const fourth = square * square;
  let upper = sixth * relative;
  let lower = third * relative;
  upper = upper + fifth;
  lower = lower + 0.5;
  upper = upper * relative;
  lower = lower * square;
  upper = upper + 0.25;
  const relativeError = relativeLow + (relativeHigh - relative);
  upper = upper * fourth;
  let polynomial = lower + upper;
  polynomial = polynomial + relativeError;
  let logTail = ln2Low * exponent;
  logTail = logTail - polynomial;
  logTail = logLow[index]! + logTail;
  const savedTail = logTail;
  logTail = logTail - relative;
  const logHead = logHigh[index]! + ln2High * exponent;

  // 02395E..0239E3: compensated log and compensated exponent product.
  const logSum = logHead + logTail;
  const head = splitHigh(logSum);
  const restoredRelative = relative + logTail;
  let tail = logHead - logSum;
  const reductionError = savedTail - restoredRelative;
  tail = tail + logTail;
  const splitError = logSum - head;
  tail = tail + reductionError;
  tail = tail + splitError;
  const powerHigh = splitHigh(power);
  const powerLow = power - powerHigh;
  let productTail = powerLow * tail;
  const productCross = powerLow * head;
  const productLow = tail * powerHigh;
  const productHigh = head * powerHigh;
  productTail = productTail + productCross;
  productTail = productTail + productLow;
  const product = productHigh + productTail;
  const productError = productHigh - product + productTail;

  // 0239E7..023A62: CVTPD2DQ nearest-even and 64-way exp reduction.
  const scaled = inverseLn2Times64 * product;
  const floor = Math.floor(scaled);
  const fraction = scaled - floor;
  const scale = floor + (fraction > 0.5 || (fraction === 0.5 && (floor & 1) !== 0) ? 1 : 0);
  const expIndex = scale & 63;
  const scaleExponent = (scale - expIndex) >> 6;
  let reduced = product - ln2Over64High * scale;
  reduced = reduced + scale * negativeLn2Over64Low;
  reduced = reduced + productError;

  // 023A66..023AC9: degree-six exponential, separate MULSD/ADDSD.
  const reducedSquare = reduced * reduced;
  let first = 0.5 * reduced;
  let middle = factorial4 * reduced;
  let last = factorial6 * reduced;
  const cube = reducedSquare * reduced;
  first = first + 1;
  middle = middle + sixth;
  const fifthPower = reducedSquare * cube;
  last = last + factorial5;
  first = first * reduced;
  middle = middle * cube;
  last = last * fifthPower;
  middle = middle + last;
  const exponential = first + middle;

  // 023AE2..023B23: table split, combine, exact binary exponent scale, sign.
  let resultLow = expLow[expIndex]! * exponential;
  let resultHigh = expHigh[expIndex]! * exponential;
  resultLow = resultLow + expLow[expIndex]!;
  resultHigh = resultHigh + resultLow;
  resultHigh = resultHigh + expHigh[expIndex]!;
  const result = resultHigh * fromWords((scaleExponent + 1023) << 20);
  return negative ? -result : result;
}
