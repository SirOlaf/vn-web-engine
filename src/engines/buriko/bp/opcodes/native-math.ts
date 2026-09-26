import type {BurikoBpOpcodeHandler} from '../../native/types.js';
import type {BurikoBpAbi} from '../abi.js';
import {x87Atan2Float} from '../../../../core/x87-integer.js';
import {
  native1665DisplayEasing,
  native1665AffineSineCosine,
  native1665CursorInterpolation,
  native1665SineCosineRadians,
} from './legacy-1665.js';
import {pop32, push32} from '../state.js';
import {pointer, pointerBytes} from './operands.js';
import {fixedResult, roundToInt32} from './fixed.js';
import {nativeEasingPower} from './native-easing-power.js';
import {
  powLogTable,
  powReciprocalTable,
  powExponentialTable,
  spatialAtanTable,
} from './math-tables.js';

const scratch = new DataView(new ArrayBuffer(8));
function bits(value: number): bigint {
  scratch.setFloat64(0, value, true);
  return scratch.getBigUint64(0, true);
}
function number(value: bigint): number {
  scratch.setBigUint64(0, BigInt.asUintN(64, value), true);
  return scratch.getFloat64(0, true);
}
function exponent(value: number): number {
  return Number((bits(value) >> 52n) & 0x7ffn);
}
function truncateInt32(value: number): number {
  const result = Math.trunc(value);
  return !Number.isFinite(result) || result < -0x80000000 || result > 0x7fffffff
    ? -0x80000000
    : result | 0;
}

/** 140145250/140144270, statically linked CRT's non-AVX SSE2 path. */
function reduceFixedAngle(angle: number): {quadrant: number; head: number; tail: number} {
  // Rain and wave row arguments additionally reach the same CRT large reducer.
  if (Math.abs(angle) >= 500000) return reduceLargeAngle(Math.abs(angle));
  const magnitude = Math.abs(angle),
    quadrant = Math.trunc(magnitude * 0.6366197723675814 + 0.5);
  let remainder = magnitude - quadrant * 1.5707963267341256;
  let correction = quadrant * 6.077100506506192e-11;
  let head = remainder - correction;
  if (exponent(magnitude) - exponent(Math.abs(head)) > 15) {
    const previous = remainder,
      highCorrection = quadrant * 6.077100506303966e-11;
    remainder -= highCorrection;
    correction = quadrant * 2.0222662487959506e-21 - (previous - remainder - highCorrection);
    head = remainder - correction;
  }
  return {quadrant, head, tail: remainder - head - correction};
}

// Three overlapping 24-byte windows beginning at 18E244, 18E243 and 18E242.
// 145910 selects their byte offset as 134 - (unbiasedExponent >>> 3).
const largeAngleWindows = [
  [0x5f47d4d377036d8an, 0x0db9391054a7f09dn, 0x28be6n],
  [0x47d4d377036d8a56n, 0xb9391054a7f09d5fn, 0x28be60dn],
  [0xd4d377036d8a5664n, 0x391054a7f09d5f47n, 0x28be60db9n],
] as const;

/** 145910 for all finite rain and wave inputs, covering unbiased exponents 18..34. */
function reduceLargeAngle(magnitude: number): {quadrant: number; head: number; tail: number} {
  const input = bits(magnitude),
    unbiased = Number(input >> 52n) - 1023;
  if (unbiased < 18 || unbiased > 34)
    throw new RangeError('Buriko large reduction outside its verified rain/wave/map angle domain');
  const mask64 = (1n << 64n) - 1n;
  const significand = (input & ((1n << 52n) - 1n)) | (1n << 52n);
  const window = largeAngleWindows[(unbiased >>> 3) - 2]!;
  const firstProduct = significand * window[0];
  const secondProduct = significand * window[1] + (firstProduct >> 64n);
  let low = firstProduct & mask64;
  let middle = secondProduct & mask64;
  let high = ((secondProduct >> 64n) + significand * window[2]) & mask64;
  const lowExponent = unbiased & 7,
    shift = 54 - lowExponent;
  const complement = ((high >> BigInt(shift - 1)) & 1n) !== 0n;
  const quadrant = Number(((high >> BigInt(shift)) + BigInt(complement)) & 3n);
  const sign = complement ? 1n << 63n : 0n;
  if (complement) {
    high ^= mask64;
    middle ^= mask64;
    low ^= mask64;
  }
  high &= (1n << BigInt(54 - lowExponent)) - 1n;
  let fractionExponent = lowExponent - 54;
  if (high === 0n) {
    high = middle;
    middle = low;
    low = 0n;
    fractionExponent -= 64;
  }
  if (high === 0n) throw new Error('Buriko large reduction reaches an undefined native BSR input');
  const topBit = high.toString(2).length - 1;
  fractionExponent += topBit;
  const normalization = topBit - 52;
  if (normalization > 0) {
    const previous = high;
    high >>= BigInt(normalization);
    middle =
      ((middle >> BigInt(normalization)) | (previous << BigInt(64 - normalization))) & mask64;
  } else if (normalization < 0) {
    const left = -normalization;
    high = ((high << BigInt(left)) | (middle >> BigInt(64 - left))) & mask64;
    middle = ((middle << BigInt(left)) | (low >> BigInt(64 - left))) & mask64;
  }
  const biasedExponent = fractionExponent + 1023;
  const fractionBits = (high & ~(1n << 52n)) | sign | (BigInt(biasedExponent) << 52n);
  const fraction = number(fractionBits);
  const fractionHigh = number(fractionBits & ~((1n << 27n) - 1n));
  const fractionLow = fraction - fractionHigh;
  if (middle === 0n)
    throw new Error('Buriko large reduction reaches an undefined native BSR input');
  const middleTopBit = middle.toString(2).length - 1;
  const middleShift = 64 - middleTopBit;
  const secondBits =
    (((middle << BigInt(middleShift & 63)) & mask64) >> 12n) |
    sign |
    (BigInt(biasedExponent - middleShift - 52) << 52n);
  const secondFraction = number(secondBits);
  const leadingProduct = fraction * 1.5707963267948966;
  let correction = fractionHigh * 1.5707963109016418 - leadingProduct;
  correction += fractionLow * 1.5707963109016418;
  correction += fractionHigh * 1.5893254712295857e-8;
  correction += fractionLow * 1.5893254712295857e-8;
  correction += fraction * 6.123233995736765e-17 + secondFraction * 1.5707963267948966;
  const head = leadingProduct + correction;
  return {quadrant, head, tail: correction + (leadingProduct - head)};
}

function sinePolynomial(head: number, tail: number): number {
  const square = head * head;
  const cubeSquare = square * square * square;
  const high =
    ((1.5918144304485914e-10 * square - 2.5051132068021698e-8) * square + 2.7557316103728802e-6) *
    cubeSquare;
  const low =
    (-0.00019841269836761127 * square + 0.00833333333333095) * square - 0.16666666666666666;
  return tail + (head * square * (high + low) - square * 0.5 * tail) + head;
}

function cosinePolynomial(head: number, tail: number): number {
  const square = head * head,
    cubeSquare = square * square * square;
  const high =
    ((-1.138263981623609e-11 * square + 2.0876146382372144e-9) * square - 2.755731727234489e-7) *
    cubeSquare;
  const low =
    (2.4801587298767044e-5 * square - 0.0013888888888887398) * square + 0.041666666666666664;
  const half = square * 0.5,
    negativeBase = half - 1;
  const correction = negativeBase + 1 - half - tail * head;
  return (low + high) * (square * square) + correction - negativeBase;
}

function sineFixedAngle(fixedDegrees: number): number {
  const angle = ((fixedDegrees | 0) * 3.141592653589793) / 11796480;
  return sineBoundedRadians(angle);
}

/** Same native SSE2 sine entry for the font coverage domain, without fixed-degree quantization. */
export function nativeSineFirstQuadrant(radians: number): number {
  if (!Number.isFinite(radians) || radians < 0 || radians > 3.141592653589793 / 2)
    throw new RangeError('Buriko font sine argument outside its verified first-quadrant domain');
  return sineBoundedRadians(radians);
}

function sineBoundedRadians(angle: number): number {
  if (Math.abs(angle) < 0.7853981633974483) {
    if (Math.abs(angle) <= 2 ** -27) return angle;
    // The unreduced entry omits the compensated-tail arithmetic.
    const square = angle * angle,
      cubeSquare = square * square * square;
    const high =
      ((1.5918144304485914e-10 * square - 2.5051132068021698e-8) * square + 2.7557316103728802e-6) *
      cubeSquare;
    const low =
      (-0.00019841269836761127 * square + 0.00833333333333095) * square - 0.16666666666666666;
    return angle + angle * square * (high + low);
  }
  const {quadrant, head, tail} = reduceFixedAngle(angle);
  const result = (quadrant & 1) === 0 ? sinePolynomial(head, tail) : cosinePolynomial(head, tail);
  return ((quadrant >>> 1) & 1) !== Number(angle < 0) ? 0 - result : result;
}

function cosineFixedAngle(fixedDegrees: number): number {
  const angle = ((fixedDegrees | 0) * 3.141592653589793) / 11796480;
  return cosineBoundedRadians(angle);
}

function cosineBoundedRadians(angle: number): number {
  if (Math.abs(angle) < 0.7853981633974483) {
    if (Math.abs(angle) < 2 ** -27) return 1;
    const square = angle * angle;
    if (Math.abs(angle) < 2 ** -13) return 1 - square * 0.5;
    const fourth = square * square,
      eighth = fourth * fourth;
    const term1 = (-0.0013888888888887398 * square + 0.041666666666666664) * fourth;
    const term2 = (-2.755731727234489e-7 * square + 2.4801587298767044e-5) * eighth;
    const term3 = fourth * eighth * (-1.138263981623609e-11 * square + 2.0876146382372144e-9);
    const negativeHalf = square * -0.5,
      base = negativeHalf + 1;
    return 1 - base + negativeHalf + (term1 + term2 + term3) + base;
  }
  const {quadrant, head, tail} = reduceFixedAngle(angle);
  const result = (quadrant & 1) === 0 ? cosinePolynomial(head, tail) : sinePolynomial(head, tail);
  return ((quadrant + 1) & 2) !== 0 ? 0 - result : result;
}

/** Spatial collision calls double sin/cos after adding PI/2 and optionally PI to atan2f. */
export function nativeSpatialSineCosine(
  angle: number,
  revision?: BurikoBpAbi['revision'],
): {sine: number; cosine: number} {
  if (!Number.isFinite(angle) || Math.abs(angle) > 8)
    throw new RangeError('Buriko spatial trigonometry outside its native argument domain');
  if (revision === '1.665') return native1665SineCosineRadians(angle);
  return {sine: sineBoundedRadians(angle), cosine: cosineBoundedRadians(angle)};
}

/** 1400a7b80 supplies signed fixed degrees divided before multiplying by PI/2. */
export function nativeGridEvaluatorFacingCosine(
  fixedDegrees: number,
  revision?: BurikoBpAbi['revision'],
): number {
  const angle = ((fixedDegrees | 0) / 11796480) * 1.5707963267948966;
  if (revision === '1.665') return native1665SineCosineRadians(angle).cosine;
  return cosineBoundedRadians(angle);
}

/** Rain 0f1a60 uses this literal rounded radians-per-degree constant, followed by division by ten. */
export function nativeRainSineCosine(tenthDegrees: number): {sine: number; cosine: number} {
  const radians = ((tenthDegrees | 0) * 0.017453292519444445) / 10;
  return {sine: sineBoundedRadians(radians), cosine: cosineBoundedRadians(radians)};
}

/** 04E700 calls 145250 with int32(phase) * (6.283185307179586 / uint32(period)). */
export function nativeWaveSineRadians(radians: number): number {
  if (!Number.isFinite(radians)) {
    // 145EDC -> 145EF0: infinity returns the fixed negative quiet NaN; a NaN retains
    // its payload/sign with the quiet bit set. This numeric branch is statically verified.
    const encoding = bits(radians);
    return number(
      (encoding & 0xfffffffffffffn) === 0n ? 0xfff8000000000000n : encoding | 0x8000000000000n,
    );
  }
  if (Math.abs(radians) > 0x80000000 * 6.283185307179586)
    throw new RangeError('Buriko wave sine argument exceeds its native phase/period domain');
  return sineBoundedRadians(radians);
}

/** 0332A0/033580/033890/034260: exact CRT radians, bounded by DWORD map arguments. */
function displacementRadians(radians: number, cosine: boolean): number {
  if (!Number.isFinite(radians)) {
    const encoding = bits(radians);
    return number(
      (encoding & 0xfffffffffffffn) === 0n ? 0xfff8000000000000n : encoding | 0x8000000000000n,
    );
  }
  if (Math.abs(radians) > 0x100000000 * 6.283185307179586)
    throw new RangeError('Buriko displacement trigonometry exceeds its verified DWORD domain');
  return cosine ? cosineBoundedRadians(radians) : sineBoundedRadians(radians);
}
export function nativeDisplacementSineRadians(
  radians: number,
  revision?: BurikoBpAbi['revision'],
): number {
  if (revision === '1.665') return native1665SineCosineRadians(radians).sine;
  return displacementRadians(radians, false);
}
export function nativeDisplacementCosineRadians(
  radians: number,
  revision?: BurikoBpAbi['revision'],
): number {
  if (revision === '1.665') return native1665SineCosineRadians(radians).cosine;
  return displacementRadians(radians, true);
}

/** Particle camera/velocity rotation uses the primary signed Q16-degree conversion. */
export function nativeParticleSineCosine(fixedDegrees: number): {sine: number; cosine: number} {
  return {sine: sineFixedAngle(fixedDegrees), cosine: cosineFixedAngle(fixedDegrees)};
}

/**
 * 140056920's signed-Q24 selector, trigonometric curves and default division.
 * Curves 4-15 use 023710's restricted non-AVX SSE2 power lower.
 */
export function nativeDisplayEasing(
  progress: number,
  easing: number,
  revision?: BurikoBpAbi['revision'],
): number {
  if (revision === '1.665') return native1665DisplayEasing(progress, easing);
  progress |= 0;
  easing |= 0;
  const scaledAngle = (multiplier: number): number =>
    Number((BigInt(progress) * BigInt(multiplier)) / 256n) | 0;
  switch (easing) {
    case 1:
      return truncateInt32((cosineFixedAngle((0xb40000 - scaledAngle(0xb4)) | 0) + 1) * 32768);
    case 2:
      return truncateInt32(sineFixedAngle(scaledAngle(0x5a)) * 65536);
    case 3:
      return truncateInt32((1 - sineFixedAngle((0x5a0000 - scaledAngle(0x5a)) | 0)) * 65536);
    default:
      if (easing >= 4 && easing <= 15) {
        const exponent = ([2, 2, 2.5, 2.5, 3, 3, 4, 4, 5, 5, 6, 6] as const)[easing - 4]!;
        const denominator = nativeEasingPower(0x1000000, exponent);
        if ((easing & 1) === 0)
          return truncateInt32((nativeEasingPower(progress, exponent) * 65536) / denominator);
        const reverse = (0x1000000 - progress) | 0;
        return truncateInt32((1 - nativeEasingPower(reverse, exponent) / denominator) * 65536);
      }
      return (progress + ((progress >> 31) & 0xff)) >> 8;
  }
}

/** 052030 negates the rounded Q16-degree angle, then separately adds the rounded PI/2. */
export function nativeAffineSineCosine(
  fixedDegrees: number,
  revision?: BurikoBpAbi['revision'],
): {
  sine: number;
  cosine: number;
  perpendicularSine: number;
  perpendicularCosine: number;
} {
  if (revision === '1.665') return native1665AffineSineCosine(fixedDegrees);
  const angle = -(((fixedDegrees | 0) * 3.141592653589793) / 11796480),
    perpendicular = angle + 1.5707963267948966;
  return {
    cosine: cosineBoundedRadians(angle),
    sine: sineBoundedRadians(angle),
    perpendicularSine: sineBoundedRadians(perpendicular),
    perpendicularCosine: cosineBoundedRadians(perpendicular),
  };
}

/** 0436B0 applies optional DWORD NEG before signed conversion, then MULSD PI and DIVSD180Q16. */
export function nativeMeshSineCosine(
  fixedDegrees: number,
  negate: boolean,
  revision?: BurikoBpAbi['revision'],
): {
  cosine: number;
  sine: number;
} {
  const value = negate ? -fixedDegrees | 0 : fixedDegrees | 0;
  const radians = (value * 3.141592653589793) / 11796480;
  if (revision === '1.665') return native1665SineCosineRadians(radians);
  return {cosine: cosineBoundedRadians(radians), sine: sineBoundedRadians(radians)};
}

/** 140143dec atan2f, complete for finite float32 coordinates (double internal operations). */
export function nativeSpatialAngle(
  y: number,
  x: number,
  revision?: BurikoBpAbi['revision'],
): number {
  if (revision === '1.665') return x87Atan2Float(Math.fround(y), Math.fround(x), 32);
  y = Math.fround(y);
  x = Math.fround(x);
  if (!Number.isFinite(y) || !Number.isFinite(x))
    throw new RangeError('Buriko spatial angle requires finite native coordinates');
  const negativeX = x < 0 || Object.is(x, -0),
    negativeY = y < 0 || Object.is(y, -0);
  if (y === 0) return negativeX ? Math.fround(negativeY ? -Math.PI : Math.PI) : y;
  if (x === 0) return Math.fround(negativeY ? -Math.PI / 2 : Math.PI / 2);
  const difference = exponent(y) - exponent(x);
  if (difference > 26) return Math.fround(negativeY ? -Math.PI / 2 : Math.PI / 2);
  if (difference < -13 && !negativeX) {
    if (difference < -150) return negativeY ? -0 : 0;
    // The native -150..-127 path scales by 2^100, divides, then reduces the
    // double exponent by 100. Every finite float32 ratio stays normal in double,
    // making this identical to the same rounded division without the scaling.
    return Math.fround(y / x);
  }
  if (difference < -26 && negativeX) return Math.fround(negativeY ? -Math.PI : Math.PI);
  const absoluteY = Math.abs(y),
    absoluteX = Math.abs(x),
    swapped = absoluteY > absoluteX;
  const numerator = swapped ? absoluteX : absoluteY,
    denominator = swapped ? absoluteY : absoluteX;
  let result = numerator / denominator;
  if (result > 0.0625) {
    const index = Math.trunc(result * 256 + 0.5);
    const remainder =
      (numerator * 256 - index * denominator) / (index * numerator + denominator * 256);
    result =
      remainder +
      spatialAtanTable[index - 16]! -
      remainder * remainder * remainder * 0.33333333333224097;
  } else if (result >= 0.0001) {
    const square = result * result;
    const correction =
      (0.3333333333333317 - (0.19999999999393223 - square * 0.1428571356180717) * square) *
      (square * result);
    result -= correction;
  }
  if (swapped) result = Math.PI / 2 - result;
  if (negativeX) result = Math.PI - result;
  if (negativeY) result = -result;
  return Math.fround(result);
}

/** 1401434d0: all finite ratios reachable from two signed32 operands. */
function atanIntegerRatio(ratio: number): number {
  const negative = ratio < 0 || Object.is(ratio, -0);
  let reduced = Math.abs(ratio),
    high = 0,
    low = 0;
  if (reduced > 2.4375) {
    high = 1.5707963267948966;
    low = number(0x3c91a62633145c06n);
    reduced = -1 / reduced;
  } else if (reduced > 1.1875) {
    high = 0.982793723247329;
    low = number(0x3c7007887af0cbbcn);
    reduced = (reduced - 1.5) / (reduced * 1.5 + 1);
  } else if (reduced > 0.6875) {
    high = 0.7853981633974483;
    low = number(0x3c81a62633145c06n);
    reduced = (reduced - 1) / (reduced + 1);
  } else if (reduced > 0.4375) {
    high = 0.4636476090008061;
    low = number(0x3c7a2b7f222f65e0n);
    reduced = (reduced + reduced - 1) / (reduced + 2);
  }
  const square = reduced * reduced;
  let numerator = square * 0.00014231690334231778 + 0.030445591950485303;
  numerator = numerator * square + 0.22063878071666743;
  numerator = numerator * square + 0.4476772068054975;
  numerator = numerator * square + 0.2682979205325459;
  let denominator = square * 0.03895258739447422 + 0.4246025942038471;
  denominator = denominator * square + 1.4125425993195893;
  denominator = denominator * square + 1.8259678773750707;
  denominator = denominator * square + 0.8048937615976377;
  const result = high - ((numerator * (square * reduced)) / denominator - low - reduced);
  return negative ? -result : result;
}

/** 140024db0 baseline powf, restricted to its complete signed32-fixed input domain. */
function powerFixed(baseCell: number, exponentCell: number): number {
  const base = Math.fround(Math.fround(baseCell | 0) / 65536),
    power = Math.fround(Math.fround(exponentCell | 0) / 65536);
  if (power === 0) return 1;
  if (power === 1) return base;
  if (base === 0) return power < 0 ? Infinity : 0;
  let negative = false;
  if (base < 0) {
    if (power !== Math.trunc(power)) return NaN;
    negative = Math.abs(power % 2) === 1;
  }
  let logarithm: number;
  const delta = base - 1;
  if (base < 1.0625 && Math.abs(delta) < 0.0625) {
    const quotient = delta / (delta + 2),
      twice = quotient + quotient,
      square = twice * twice;
    const cube = twice * square,
      seventh = square * square * cube;
    const first = cube * (square * 0.012500000003771751 + 0.08333333333333179);
    const second = seventh * (square * 0.0004348877777076146 + 0.0022321399879194482);
    logarithm = delta + (first + second - quotient * delta);
  } else {
    const encoding = bits(base),
      mantissa = encoding & 0xfffffffffffffn;
    const index = Number((mantissa >> 44n) + ((mantissa >> 43n) & 1n));
    const normalized = number(mantissa | 0x3fe0000000000000n);
    const tableCenter = number(BigInt(index | 0x3fe00) << 44n);
    const relative = (tableCenter - normalized) * powReciprocalTable[index]!;
    const polynomial = relative * relative * (relative * 0.3333333333333333 + 0.5) + relative;
    logarithm =
      (Number((encoding >> 52n) & 0x7ffn) - 1023) * 0.6931471805599453 +
      powLogTable[index]! -
      polynomial;
  }
  const product = power * logarithm;
  if (product > 88.72283935546875) return negative ? -Infinity : Infinity;
  if (product <= -103.2789306640625) return negative ? -0 : 0;
  const scale = roundToInt32(product * 92.33248261689366);
  const reduced = product - scale * 0.010830424696249145;
  const polynomial = reduced * reduced * (reduced * 0.16666666666666666 + 0.5) + reduced;
  const factor = powExponentialTable[scale & 63]!;
  const encoded = bits(polynomial * factor + factor) + (BigInt(scale >> 6) << 52n);
  const result = Math.fround(number(encoded));
  return negative ? -result : result;
}

/** 1400315f0, shared by primary 43 and native touch-history direction queries. */
export function nativeVectorAngle(x: number, y: number): number {
  x |= 0;
  y |= 0;
  if (x === 0) return y === 0 ? 0 : y > 0 ? 0x5a0000 : 0x10e0000;
  const arc = atanIntegerRatio(y / x);
  return x > 0 && y >= 0
    ? truncateInt32((arc * 11796480) / 3.141592653589793)
    : (x > 0 ? 0x1680000 : 0xb40000) - truncateInt32((arc * -11796480) / 3.141592653589793);
}

/** 1400ef720, called only with 0 < progress < steps by the native cursor controller. */
export function nativeCursorInterpolation(
  delta: number,
  easing: number,
  progress: number,
  steps: number,
  revision?: BurikoBpAbi['revision'],
): number {
  if (revision === '1.665') return native1665CursorInterpolation(delta, easing, progress, steps);
  delta |= 0;
  easing |= 0;
  progress >>>= 0;
  steps >>>= 0;
  if (steps === 0) throw new Error('Buriko native cursor interpolation division by zero');
  if (easing !== 1) return Math.imul(Math.floor(((progress << 16) >>> 0) / steps), delta) >> 16;
  const angle256 = (0xb400 - Math.floor((Math.imul(progress, 0xb400) >>> 0) / steps)) | 0;
  // Multiplying numerator and denominator by 256 is exact here, preserving the native binary64 radians.
  const factor = truncateInt32((cosineFixedAngle(angle256 << 8) + 1) * 32768);
  return Math.imul(factor, delta) >> 16;
}

export const nativeMathOpcodes: Readonly<Record<number, BurikoBpOpcodeHandler>> = {
  0x43: (h) => {
    const y = pop32(h.thread) | 0,
      x = pop32(h.thread) | 0;
    push32(h.thread, nativeVectorAngle(x, y));
    return 0;
  },
  0x44: (h) => {
    const z = pop32(h.thread) | 0,
      y = pop32(h.thread) | 0,
      x = pop32(h.thread) | 0;
    push32(h.thread, truncateInt32(Math.sqrt(y * y + x * x + z * z)));
    return 0;
  },
  0x45: (h) => {
    const zAngle = pop32(h.thread) | 0,
      yAngle = pop32(h.thread) | 0,
      xAngle = pop32(h.thread) | 0;
    const source = pointer(h, pop32(h.thread)),
      destination = pointer(h, pop32(h.thread));
    const sourceBytes = pointerBytes(source, 12),
      input = new DataView(sourceBytes.buffer, sourceBytes.byteOffset, 12);
    const x = input.getInt32(0, true),
      y = input.getInt32(4, true),
      z = input.getInt32(8, true);
    const sx = sineFixedAngle(xAngle),
      cx = cosineFixedAngle(xAngle);
    const afterXy = cx * y - sx * z,
      afterXz = cx * z + sx * y;
    const sy = sineFixedAngle(yAngle),
      cy = cosineFixedAngle(yAngle),
      afterYx = sy * afterXz + cy * x;
    const sz = sineFixedAngle(zAngle),
      cz = cosineFixedAngle(zAngle);
    const bytes = pointerBytes(destination, 12, 0, 'write'),
      output = new DataView(bytes.buffer, bytes.byteOffset, 12);
    output.setInt32(0, truncateInt32(Math.floor(cz * afterYx - sz * afterXy + 0.5)), true);
    output.setInt32(4, truncateInt32(Math.floor(cz * afterXy + sz * afterYx + 0.5)), true);
    output.setInt32(8, truncateInt32(Math.floor(cy * afterXz - sy * x + 0.5)), true);
    return 0;
  },
  0x48: (h) => {
    push32(h.thread, truncateInt32(sineFixedAngle(pop32(h.thread)) * 65536));
    return 0;
  },
  0x49: (h) => {
    push32(h.thread, truncateInt32(cosineFixedAngle(pop32(h.thread)) * 65536));
    return 0;
  },
  0x55: (h) => {
    const power = pop32(h.thread),
      base = pop32(h.thread);
    push32(h.thread, fixedResult(powerFixed(base, power)));
    return 0;
  },
};
