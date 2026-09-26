import {
  exp,
  logA,
  logB,
  logC,
  reciprocalA,
  reciprocalB,
  reciprocalC,
} from './native-power-1665-tables.js';

type Vec = [bigint, bigint];

const QMASK = 0xffff_ffff_ffff_ffffn;
const MANTISSA = 0x000f_ffff_ffff_ffffn;
const SIGN = 0x8000_0000_0000_0000n;
const bitsView = new DataView(new ArrayBuffer(8));

function bits(value: number): bigint {
  bitsView.setFloat64(0, value, true);
  return bitsView.getBigUint64(0, true);
}

function number(value: bigint): number {
  bitsView.setBigUint64(0, value & QMASK, true);
  return bitsView.getFloat64(0, true);
}

function imm(value: number): bigint {
  return BigInt(value >>> 0);
}

function movlpd(value: number): Vec {
  return [bits(value), 0n];
}

function movlpdBits(value: bigint): Vec {
  return [value & QMASK, 0n];
}

function movapd(low: number, high: number): Vec {
  return [bits(low), bits(high)];
}

function addpd(a: Vec, b: Vec): Vec {
  return [bits(number(a[0]) + number(b[0])), bits(number(a[1]) + number(b[1]))];
}

function mulpd(a: Vec, b: Vec): Vec {
  return [bits(number(a[0]) * number(b[0])), bits(number(a[1]) * number(b[1]))];
}

function addSd(a: Vec, b: Vec): Vec {
  return [bits(number(a[0]) + number(b[0])), a[1]];
}

function subSd(a: Vec, b: Vec): Vec {
  return [bits(number(a[0]) - number(b[0])), a[1]];
}

function mulSd(a: Vec, b: Vec): Vec {
  return [bits(number(a[0]) * number(b[0])), a[1]];
}

function andpd(a: Vec, b: Vec): Vec {
  return [a[0] & b[0], a[1] & b[1]];
}

function orpd(a: Vec, b: Vec): Vec {
  return [a[0] | b[0], a[1] | b[1]];
}

function pextrw(a: Vec, index: number): number {
  const lane = a[index >>> 2]!;
  return Number((lane >> BigInt((index & 3) * 16)) & 0xffffn);
}

function psubq(a: Vec, b: Vec): Vec {
  return [(a[0] - b[0]) & QMASK, (a[1] - b[1]) & QMASK];
}

function psrlq(a: Vec, shift: number): Vec {
  return [a[0] >> BigInt(shift), a[1] >> BigInt(shift)];
}

function psllq(a: Vec, shift: number): Vec {
  return [(a[0] << BigInt(shift)) & QMASK, (a[1] << BigInt(shift)) & QMASK];
}

function cvtdq2pd(a: Vec): Vec {
  return [
    bits(Number(BigInt.asIntN(32, a[0] & 0xffff_ffffn))),
    bits(Number(BigInt.asIntN(32, (a[0] >> 32n) & 0xffff_ffffn))),
  ];
}

function movd(value: number): Vec {
  return [imm(value), 0n];
}

function pinsrw(a: Vec, value: number, index: number): Vec {
  const lane = index >>> 2,
    shift = BigInt((index & 3) * 16),
    mask = 0xffffn << shift;
  a[lane] = (a[lane]! & ~mask) | (BigInt(value & 0xffff) << shift);
  return a;
}

function pshufdEe(a: Vec): Vec {
  return [a[1]!, a[1]!];
}

function pshufd44(a: Vec): Vec {
  return [a[0], a[0]];
}

function unpcklpd(a: Vec): Vec {
  return [a[0], a[0]];
}

function roundToInt32(value: number): number {
  // CVTSD2SI uses MXCSR round-to-nearest-even. This path is bounded to int32.
  const lower = Math.floor(value), fraction = value - lower;
  const rounded =
    fraction < 0.5 ? lower : fraction > 0.5 ? lower + 1 : (lower & 1) === 0 ? lower : lower + 1;
  return rounded | 0;
}

function tablePair(values: readonly number[], index: number): Vec {
  return movapd(values[index * 2]!, values[index * 2 + 1]!);
}

function nativePositiveFinitePower(base: number, power: number): number {
  if (base === 1) return 1;
  // Primary 55 supplies finite binary32 values; display easing supplies
  // finite int32 bases. Both nonzero domains are normal binary64, so only
  // 004e02f9..004e05c6 is reachable here.
  let xmm0 = movlpd(base),
    xmm1 = movlpd(power),
    xmm2 = movlpd(1),
    xmm3: Vec = [0n, 0n],
    xmm4: Vec = [0n, 0n],
    xmm5: Vec = [0n, 0n],
    xmm6: Vec = [0n, 0n],
    xmm7 = movlpdBits(MANTISSA);
  // 004e029c..004e02e1: normalize and split the base through the first table.
  xmm7 = andpd(xmm7, xmm0);
  xmm4 = [...xmm0];
  xmm0 = psrlq(xmm0, 44);
  let eax = pextrw(xmm0, 0),
    ecx = pextrw(xmm4, 3);
  xmm7 = orpd(xmm7, xmm2);
  eax = ((eax & 0xff) + 1) & 0x1fe;
  xmm7 = mulSd(xmm7, movlpd(reciprocalA[eax >>> 1]!));
  xmm5 = movlpd(reciprocalA[eax >>> 1]!);
  eax += eax;
  xmm6 = tablePair(logA, eax >>> 2);

  // 004e02e1..004e0314: all reachable bases are in the normal-range leg.
  ecx = 0;
  xmm0 = psubq(xmm0, movd(0x3fe7f));
  xmm0 = psrlq(xmm0, 8);
  xmm0 = cvtdq2pd(xmm0);

  // 004e0314..004e03b6: two further reciprocal/log reductions.
  xmm1 = movlpdBits(0xffff_ffff_f800_0000n);
  xmm3 = [...xmm7];
  xmm7 = psrlq(xmm7, 38);
  eax = pextrw(xmm7, 0);
  xmm4 = andpd(xmm4, movlpdBits(MANTISSA));
  eax = ((eax & 0xff) + 1) & 0x1fe;
  xmm3 = mulSd(xmm3, movlpd(reciprocalB[eax >>> 1]!));
  xmm5 = mulSd(xmm5, movlpd(reciprocalB[eax >>> 1]!));
  eax += eax;
  xmm6 = addpd(xmm6, tablePair(logB, eax >>> 2));
  xmm6 = addSd(xmm6, xmm0);
  xmm4 = orpd(xmm4, xmm2);
  xmm1 = andpd(xmm1, xmm4);
  xmm2 = [...xmm3];
  xmm3 = psrlq(xmm3, 31);
  eax = pextrw(xmm3, 0);
  xmm0 = movlpdBits(0xffff_ffff_f800_0000n);
  xmm4 = subSd(xmm4, xmm1);
  xmm7 = movlpd(-1.442694902420044);
  eax = ((eax & 0x1ff) + 1) & 0x3fe;
  xmm5 = mulSd(xmm5, movlpd(reciprocalC[eax >>> 1]!));
  xmm2 = mulSd(xmm2, movlpd(reciprocalC[eax >>> 1]!));
  xmm6 = addpd(xmm6, tablePair(logC, eax >>> 1));

  // 004e03b6..004e0428: compensated log split/product preparation.
  xmm0 = andpd(xmm0, xmm5);
  xmm5 = subSd(xmm5, xmm0);
  xmm7 = addSd(xmm7, xmm2);
  xmm3 = [...xmm0];
  xmm0 = mulSd(xmm0, xmm1);
  xmm1 = mulSd(xmm1, xmm5);
  xmm3 = mulSd(xmm3, xmm4);
  xmm2 = subSd(xmm2, xmm0);
  xmm4 = mulSd(xmm4, xmm5);
  xmm0 = [...xmm6];
  xmm2 = subSd(xmm2, xmm1);
  xmm6 = addSd(xmm6, xmm7);
  xmm1 = movlpd(power);
  eax = pextrw(xmm1, 3);
  xmm2 = subSd(xmm2, xmm3);
  xmm0 = subSd(xmm0, xmm6);
  xmm3 = movlpdBits(0xffff_ffff_f800_0000n);
  let edx = pextrw(xmm6, 3);
  xmm2 = subSd(xmm2, xmm4);
  xmm4 = [...xmm6];
  xmm0 = addSd(xmm0, xmm7);
  xmm7 = subSd(xmm7, xmm2);
  xmm6 = subSd(xmm6, xmm2);
  xmm7 = unpcklpd(xmm7);

  // Finite f32 exponents can still push the result beyond the CRT's ordinary
  // scaling interval. Those values collapse to zero/infinity after the
  // primary opcode's required f32 rounding. Display-easing inputs stay inside.
  eax &= 0x7ff0;
  edx &= 0x7ff0;
  eax = (eax - 0x3ff0 + edx) | 0;
  if (((0x40a0 - eax) | (eax - 0x3c70)) < 0) return overflowOrUnderflow(base, power);

  // 004e0455..004e04dc: split product and round the 128-way exp scale.
  xmm4 = subSd(xmm4, xmm6);
  xmm2 = subSd(xmm2, xmm4);
  xmm4 = movlpdBits(0xffff_ffff_f800_0000n);
  xmm3 = andpd(xmm3, xmm1);
  xmm4 = andpd(xmm4, xmm6);
  xmm0 = subSd(xmm0, xmm2);
  xmm2 = pinsrw([0n, 0n], 0x4060, 3);
  xmm5 = [...xmm3];
  xmm3 = mulSd(xmm3, xmm4);
  xmm6 = subSd(xmm6, xmm4);
  xmm1 = subSd(xmm1, xmm5);
  xmm3 = mulSd(xmm3, xmm2);
  xmm5 = mulSd(xmm5, xmm6);
  xmm2 = movapd(0.16015105075297303, 9.597935033233511e-8);
  xmm4 = mulSd(xmm4, xmm1);
  xmm6 = mulSd(xmm6, xmm1);
  xmm1 = movapd(-0.08325619496072671, -0.3465736568077919);
  const scale = roundToInt32(number(xmm3[0]));
  xmm5 = addSd(xmm5, xmm4);
  xmm4 = pshufdEe(xmm6);
  xmm5 = addSd(xmm5, xmm6);
  edx = 0x1ff7f - scale;
  eax = scale + 0x1e1ff;
  edx |= eax;
  eax -= 0x1e1ff;
  if (edx <= 0) return overflowOrUnderflow(base, power);
  ecx += eax;
  eax &= 0x7f;
  ecx &= 0xffff_ff80;
  ecx += 0x1ff80;
  xmm4 = addSd(xmm4, xmm0);
  xmm0 = [...xmm3];
  xmm3 = addSd(xmm3, movlpd(6755399441055744));
  xmm3 = subSd(xmm3, movlpd(6755399441055744));
  xmm0 = subSd(xmm0, xmm3);
  xmm2 = mulpd(xmm2, xmm7);
  xmm7 = mulpd(xmm7, xmm7);

  // 004e050e..004e05c6: degree-seven exponential and native scale combine.
  eax *= 16;
  xmm3 = tablePair(exp, eax >>> 4);
  xmm6 = movapd(0.0013333558146428443, 0.055504108664821576);
  xmm1 = mulpd(xmm1, xmm7);
  xmm2 = addpd(xmm2, xmm1);
  xmm1 = pshufdEe(xmm2);
  xmm2 = mulSd(xmm2, xmm7);
  xmm7 = pinsrw([0n, 0n], 0x3f80, 3);
  xmm2 = addSd(xmm2, xmm1);
  xmm2 = addSd(xmm2, xmm4);
  xmm4 = movlpd(0.6931471805599453);
  xmm1 = movd(ecx);
  xmm2 = mulSd(xmm2, movlpd(power));
  xmm0 = mulSd(xmm0, xmm7);
  xmm1 = psllq(xmm1, 45);
  xmm1 = pshufd44(xmm1);
  xmm7 = movapd(0.009618129107628477, 0.2402265069591007);
  xmm5 = addSd(xmm5, xmm2);
  xmm3 = mulpd(xmm3, xmm1);
  xmm0 = addSd(xmm0, xmm5);
  xmm0 = unpcklpd(xmm0);
  xmm6 = mulpd(xmm6, xmm0);
  xmm4 = mulSd(xmm4, xmm0);
  xmm0 = mulpd(xmm0, xmm0);
  xmm7 = addpd(xmm7, xmm6);
  xmm7 = mulpd(xmm7, xmm0);
  xmm0 = mulSd(xmm0, xmm3);
  xmm6 = pshufdEe(xmm7);
  xmm0 = mulSd(xmm0, xmm7);
  xmm5 = pshufdEe(xmm3);
  xmm6 = mulSd(xmm6, xmm3);
  xmm4 = mulSd(xmm4, xmm3);
  xmm0 = addSd(xmm0, xmm5);
  xmm0 = addSd(xmm0, xmm6);
  xmm0 = addSd(xmm0, xmm4);
  xmm0 = addSd(xmm0, xmm3);
  return number(xmm0[0]);
}

function overflowOrUnderflow(base: number, power: number): number {
  return base > 1 ? (power > 0 ? Infinity : 0) : power > 0 ? 0 : Infinity;
}

/** Jeweha 004e0250's CRT double pow for finite primary-55 and easing inputs. */
export function nativePower1665(base: number, power: number): number {
  if (power === 0) return 1;
  if (base === 0) return power < 0 ? Infinity : 0;
  if (base === 1) return 1;
  let negative = false;
  if (base < 0) {
    if (power !== Math.trunc(power)) return NaN;
    negative = Math.abs(power % 2) === 1;
    base = -base;
  }
  const result = nativePositiveFinitePower(base, power);
  return negative ? -result : result;
}
