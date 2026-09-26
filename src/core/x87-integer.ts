/**
 * Certified integer observations of Intel/Pentium-and-later x87 transcendental
 * instructions, followed by FMUL (PC=53, nearest-even) and FISTP i64 (truncate).
 *
 * Intel's Ferguson/Cornea/Anderson/Schneider paper, pp.2–3, defines FSIN/FCOS
 * as sin/cos(x*pi/p), with exact reduction and <1 extended ULP error in
 * nearest-even mode. SDM vol.1 §8.3.10 gives the corresponding FPATAN bound.
 * https://www.arithmazium.org/library/lib/x87trigonometricinstructionsvsmathfunctions.pdf
 * https://www.intel.com/content/dam/www/public/us/en/documents/manuals/64-ia-32-architectures-software-developer-vol-1-manual.pdf
 *
 * This does not pick an arbitrary result within that hardware error interval.
 * When the observable integer is processor-dependent, uncertainty is explicit.
 */

const FRACTION_BITS = 192n;
const UNIT = 1n << FRACTION_BITS;
// p = 0.C90FDAA22168C234C(hex) * 4, including its two trailing zero bits.
const PERIOD_PI = 0xc90fdaa22168c234cn << (FRACTION_BITS - 66n);
interface Interval {
  lo: bigint;
  hi: bigint;
}
const exact = (n: bigint): Interval => ({lo: n, hi: n});
const absolute = (n: bigint): bigint => (n < 0n ? -n : n);
const neg = (a: Interval): Interval => ({lo: -a.hi, hi: -a.lo});
const add = (a: Interval, b: Interval): Interval => ({lo: a.lo + b.lo, hi: a.hi + b.hi});
const subtract = (a: Interval, b: Interval): Interval => add(a, neg(b));

function floorDivide(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new RangeError('Interval denominator must be positive');
  return n / d - BigInt(n < 0n && n % d !== 0n);
}
const ceilDivide = (n: bigint, d: bigint): bigint => -floorDivide(-n, d);
function divideInteger(a: Interval, d: bigint): Interval {
  return {lo: floorDivide(a.lo, d), hi: ceilDivide(a.hi, d)};
}
function multiply(a: Interval, b: Interval): Interval {
  const values = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi];
  let lo = values[0]!,
    hi = lo;
  for (const value of values) {
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  return {lo: floorDivide(lo, UNIT), hi: ceilDivide(hi, UNIT)};
}
function divide(a: Interval, b: Interval): Interval {
  if (b.lo <= 0n) throw new RangeError('Interval division requires a positive denominator');
  return multiply(a, {lo: floorDivide(UNIT * UNIT, b.hi), hi: ceilDivide(UNIT * UNIT, b.lo)});
}

const float = new DataView(new ArrayBuffer(8));
/** Exact normal binary64 embedding, with directed enclosure below the fixed-point grid. */
function fromDouble(n: number): Interval {
  if (n === 0) return exact(0n);
  float.setFloat64(0, n, true);
  const bits = float.getBigUint64(0, true);
  const shift = Number((bits >> 52n) & 0x7ffn) - 1023 - 52 + Number(FRACTION_BITS);
  const significand = (bits & 0xfffffffffffffn) | 0x10000000000000n;
  const signed = bits >> 63n ? -significand : significand;
  if (shift < 0) {
    const divisor = 1n << BigInt(-shift);
    return {lo: floorDivide(signed, divisor), hi: ceilDivide(signed, divisor)};
  }
  return exact(signed << BigInt(shift));
}

/** Alternating atan series; |x|<=1/2, with an explicit next-term remainder. */
function atanSeries(x: Interval): Interval {
  const square = multiply(x, x);
  let power = x,
    sum = x;
  for (let n = 1; n <= 96; n++) {
    power = multiply(power, square);
    const term = divideInteger(power, BigInt(2 * n + 1));
    sum = n & 1 ? subtract(sum, term) : add(sum, term);
  }
  const next = divideInteger(multiply(power, square), 195n);
  const error = absolute(next.lo) > absolute(next.hi) ? absolute(next.lo) : absolute(next.hi);
  return {lo: sum.lo - error, hi: sum.hi + error};
}

// Machin's identity derives a rigorous pi interval; no rounded host Math.PI.
const PI = subtract(
  multiply(exact(16n * UNIT), atanSeries(divideInteger(exact(UNIT), 5n))),
  multiply(exact(4n * UNIT), atanSeries(divideInteger(exact(UNIT), 239n))),
);

function atan(x: Interval): Interval {
  if (x.hi < 0n) return neg(atan(neg(x)));
  if (x.lo > UNIT) return subtract(divideInteger(PI, 2n), atan(divide(exact(UNIT), x)));
  if (x.lo > UNIT / 2n)
    return add(
      divideInteger(PI, 4n),
      atanSeries(divide(subtract(x, exact(UNIT)), add(x, exact(UNIT)))),
    );
  return atanSeries(x);
}

/** Taylor remainder is bounded by the next term for |x|<pi/4. */
function sineCosineSeries(x: Interval, cosine: boolean): Interval {
  const square = multiply(x, x);
  let term = cosine ? exact(UNIT) : x,
    sum = term;
  for (let n = 1; n <= 48; n++) {
    const order = 2 * n + Number(!cosine);
    term = divideInteger(multiply(term, square), BigInt(order * (order - 1)));
    sum = n & 1 ? subtract(sum, term) : add(sum, term);
  }
  const order = 98 + Number(!cosine);
  const next = divideInteger(multiply(term, square), BigInt(order * (order - 1)));
  const error = absolute(next.lo) > absolute(next.hi) ? absolute(next.lo) : absolute(next.hi);
  return {lo: sum.lo - error, hi: sum.hi + error};
}

function sineCosine(input: Interval, cosine: boolean): Interval {
  // Bounded binary64 inputs embed exactly. Intel's reduction has no rounding.
  const x = input.lo;
  const quadrant = floorDivide(2n * x + PERIOD_PI / 2n, PERIOD_PI);
  const remainder = x - quadrant * (PERIOD_PI / 2n);
  const angle = divide(multiply(exact(remainder), PI), exact(PERIOD_PI));
  const q = Number(BigInt.asUintN(2, quadrant + BigInt(cosine)));
  const value = sineCosineSeries(angle, (q & 1) !== 0);
  return q >= 2 ? neg(value) : value;
}

/** Expand by one extended ULP, using the largest exponent in the enclosure. */
function nativeError(value: Interval): Interval {
  const magnitude =
    absolute(value.lo) > absolute(value.hi) ? absolute(value.lo) : absolute(value.hi);
  const shift = magnitude.toString(2).length - 1 - 63;
  const ulp = shift >= 0 ? 1n << BigInt(shift) : 1n;
  return {lo: value.lo - ulp, hi: value.hi + ulp};
}

/** Round an exact fixed-point endpoint to a 53-bit significand, ties to even. */
function round53(n: bigint): bigint {
  const magnitude = absolute(n),
    shift = magnitude.toString(2).length - 53;
  if (shift <= 0) return n;
  const s = BigInt(shift),
    half = 1n << (s - 1n);
  let rounded = magnitude >> s;
  const remainder = magnitude - (rounded << s);
  if (remainder > half || (remainder === half && (rounded & 1n) !== 0n)) rounded++;
  return (n < 0n ? -rounded : rounded) << s;
}

export type X87TrigonometricOperation = 'sin' | 'cos' | 'atan';
export class X87IntegerUncertainty extends Error {
  constructor(
    readonly operation: X87TrigonometricOperation,
    readonly input: number,
    readonly multiplier: number,
  ) {
    super(`x87 ${operation} integer observation requires a CPU-specific result for input ${input}`);
    this.name = 'X87IntegerUncertainty';
  }
}

/**
 * The input and multiplier are exact binary64 values, after preceding PC=53
 * operations. Domain: zero or 2^-64<=|input|<2^63; |multiplier|<2^63 with the
 * same lower bound. Intermediate values remain normal in x87. This function
 * observes only the final integer, not FPU status flags or register bits.
 */
export function x87TrigonometricInteger(
  operation: X87TrigonometricOperation,
  input: number,
  multiplier: number,
): number {
  const valid = (n: number): boolean =>
    Number.isFinite(n) && (n === 0 || Math.abs(n) >= 2 ** -64) && Math.abs(n) < 2 ** 63;
  if (!valid(input) || !valid(multiplier))
    throw new RangeError('x87 integer observation is outside its bounded normal domain');
  const argument = fromDouble(input);
  const mathematical =
    operation === 'atan' ? atan(argument) : sineCosine(argument, operation === 'cos');
  const product = multiply(nativeError(mathematical), fromDouble(multiplier));
  const lo = round53(product.lo) / UNIT,
    hi = round53(product.hi) / UNIT;
  const minimum = -(1n << 63n),
    maximum = (1n << 63n) - 1n;
  // A masked FISTP invalid result is the signed64 indefinite value, lowDWORD0.
  if (lo > maximum || hi < minimum) return 0;
  if (lo !== hi || lo < minimum || hi > maximum)
    throw new X87IntegerUncertainty(operation, input, multiplier);
  return Number(BigInt.asIntN(32, lo));
}

export class X87FloatingUncertainty extends Error {
  constructor(
    readonly y: number,
    readonly x: number,
    readonly precision: 32 | 64,
  ) {
    super(
      `x87 atan2 binary${precision} observation requires a CPU-specific result for inputs ${y}, ${x}`,
    );
    this.name = 'X87FloatingUncertainty';
  }
}

/** FPATAN followed by nearest-even FSTP binary64 and optional binary32 conversion.
 * Finite integer or binary32 operands embed exactly; interval arithmetic also
 * encloses ratios below its fixed-point precision. Status flags are not observed. */
export function x87Atan2Float(y: number, x: number, precision: 32 | 64): number {
  const supported = (value: number): boolean =>
    Number.isFinite(value) && (Number.isInteger(value) || Math.fround(value) === value);
  if (!supported(y) || !supported(x))
    throw new RangeError('x87 atan2 observation requires finite integer or binary32 operands');
  const negativeY = y < 0 || Object.is(y, -0),
    negativeX = x < 0 || Object.is(x, -0);
  if (y === 0 && !negativeX) return y;
  let angle: Interval;
  if (y === 0) angle = PI;
  else if (x === 0) angle = divideInteger(PI, 2n);
  else {
    angle = atan(divide(fromDouble(Math.abs(y)), fromDouble(Math.abs(x))));
    if (negativeX) angle = subtract(PI, angle);
  }
  if (negativeY) angle = neg(angle);
  // The CRT takes absolute operands, then FLDPI/FSUBRP for negative x.
  // Two additional ULPs enclose the rounded PI constant and subtraction;
  // PI can have one higher exponent than the final quadrant-corrected angle.
  const native = negativeX ? nativeError(nativeError(nativeError(angle))) : nativeError(angle);
  const rounded = (value: bigint): number => {
    const double = Number(round53(value)) / Number(UNIT);
    return precision === 32 ? Math.fround(double) : double;
  };
  const low = rounded(native.lo),
    high = rounded(native.hi);
  if (low === 0 && high === 0) return negativeY ? -0 : 0;
  if (!Object.is(low, high)) throw new X87FloatingUncertainty(y, x, precision);
  return low;
}
