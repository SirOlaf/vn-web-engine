import type {BurikoBpOpcodeContext, BurikoBpOpcodeHandler} from '../../native/types.js';
import {
  pop32,
  popDeferred32,
  push32,
  pushIndeterminate32,
  setPc,
  validCodeAddress,
  writeFrame32,
} from '../state.js';
import {readU8, readVarInt} from '../decode.js';
import {
  accessSize,
  localDescriptor,
  pointer,
  pointerBytes,
  readScalar,
  writeDeferredScalar,
} from './operands.js';
import {fixedResult} from './fixed.js';
import {nativePower1665} from './native-power-1665.js';

const scratch = new DataView(new ArrayBuffer(8));

function bits(value: number): bigint {
  scratch.setFloat64(0, value, true);
  return scratch.getBigUint64(0, true);
}

function decodeWords(words: string): readonly number[] {
  return words
    .trim()
    .split(/\s+/)
    .map((word) => {
      scratch.setBigUint64(0, BigInt(`0x${word}`), true);
      return scratch.getFloat64(0, true);
    });
}

function truncateInt32(value: number): number {
  const result = Math.trunc(value);
  return !Number.isFinite(result) || result < -0x80000000 || result > 0x7fffffff
    ? -0x80000000
    : result | 0;
}

function atanPolynomial(value: number, coefficients: readonly number[]): number {
  const square = value * value,
    fourth = square * square;
  let low = coefficients[coefficients.length - 2]!,
    high = coefficients[coefficients.length - 1]!;
  for (let index = coefficients.length - 4; index >= 0; index -= 2) {
    low = low * fourth + coefficients[index]!;
    high = high * fourth + coefficients[index + 1]!;
  }
  return (low * square + high) * value;
}

/** 004ee970: all finite ratios of two signed DWORDs stay within its ordinary SSE2 path. */
function nativeAtan(value: number): number {
  const magnitude = Math.abs(value);
  if (magnitude < 7.450580596923828e-9) return value;
  if (magnitude < 0.03125) return value - atanPolynomial(value, atanShort);
  if (magnitude < 0.375) return value - atanPolynomial(value, atanLong);
  let index: number, reduced: number;
  if (magnitude < 8) {
    index = (Number(bits(magnitude + 8) >> 44n) - 0x40201) * 3;
    const center = atanReduction[index + 2]!;
    reduced = (magnitude - center) / (magnitude * center + 1);
  } else {
    index = 0x300;
    reduced = -1 / magnitude;
  }
  const result =
    atanReduction[index]! -
    (atanPolynomial(reduced, atanShort) - atanReduction[index + 1]! - reduced);
  return value < 0 ? -result : result;
}

/** 004ef390/004eec60: 64-way Intel CRT reduction and compensated SSE2 polynomials.
 * Signed Q16-degree operands cannot reach the CRT's large-angle fallback. */
function nativeTrig(fixedDegrees: number, cosine: boolean): number {
  return nativeTrigRadians(((fixedDegrees | 0) * 3.141592653589793) / 11796480, cosine);
}

function nativeTrigRadians(angle: number, cosine: boolean): number {
  if (angle === 0) return cosine ? 1 : angle;
  const scaled = angle * 10.185916357881302;
  const rounded = scaled + 6755399441055744 - 6755399441055744;
  const index = (((rounded | 0) + (cosine ? 16 : 0)) & 63) * 4;
  const [cosineHead, sineHead, sineTail, cosineTail] = trigReduction.slice(index, index + 4) as [
    number,
    number,
    number,
    number,
  ];
  const first = angle - rounded * 0.09817477042088285;
  const second = rounded * 3.798187816439979e-12;
  const head = first - second;
  const tail = rounded * 1.2639164054974691e-22 - (first - head - second);
  const square = head * head,
    fourth = square * square;
  const cosineSum = cosineHead + cosineTail;
  const sinePolynomial =
    -0.16666666666666666 +
    0.008333333333333333 * square +
    (0.0000027557319223985893 * first * head - 0.0001984126984126984) * fourth;
  const cosinePolynomial =
    -0.5 +
    0.041666666666666664 * square +
    (0.0000248015873015873 * first * head - 0.001388888888888889) * fourth;
  const sineTerm = sinePolynomial * (cosineSum * head * square);
  const cosineTerm = cosinePolynomial * (sineHead * square);
  const productLow = cosineTail * head;
  const productHigh = head * cosineHead;
  const sumLow = productLow + sineHead;
  const sum = productHigh + sumLow;
  let correction = tail * (sineHead * head - cosineSum);
  correction += sineTail;
  correction += sineHead - sumLow + productLow;
  correction += sumLow - sum + productHigh;
  correction += sineTerm;
  correction += cosineTerm;
  return sum + correction;
}

/** 00401170 retains the native quadrant formulas and separate multiplication/division. */
export function native1665VectorAngle(x: number, y: number): number {
  x |= 0;
  y |= 0;
  if (x === 0) return y === 0 ? 0 : y > 0 ? 0x5a0000 : 0x10e0000;
  const arc = nativeAtan(y / x);
  return x > 0 && y >= 0
    ? truncateInt32((arc * 11796480) / 3.141592653589793)
    : (x > 0 ? 0x1680000 : 0xb40000) - truncateInt32((arc * -11796480) / 3.141592653589793);
}

/** The same signed Q16-degree conversion used by the x86 particle and sprite owners. */
export function native1665SineCosine(fixedDegrees: number): {sine: number; cosine: number} {
  return {sine: nativeTrig(fixedDegrees, false), cosine: nativeTrig(fixedDegrees, true)};
}

/** Intel CRT ordinary SSE2 reduction, including its signed zero result.
 * The x87 large-angle fallback remains a distinct native numerical boundary. */
export function native1665SineCosineRadians(radians: number): {sine: number; cosine: number} {
  const highWord = Number((bits(radians) >> 48n) & 0x7fffn);
  if (radians === 0) return {sine: radians, cosine: 1};
  if (!Number.isFinite(radians) || highWord > 0x40f5)
    throw new RangeError('Buriko 1.665 trigonometry requires its unimplemented x87 CRT fallback');
  if (highWord < 0x3030)
    return {
      sine:
        highWord < 0x10 ? radians * 0.9999999999999999 : (2 ** 55 * radians - radians) * 2 ** -55,
      cosine: 1 - Math.abs(radians),
    };
  return {sine: nativeTrigRadians(radians, false), cosine: nativeTrigRadians(radians, true)};
}

/** 004200c0: signed-Q24 curves call the same Intel CRT as primary 55. */
export function native1665DisplayEasing(progress: number, easing: number): number {
  progress |= 0;
  easing |= 0;
  const scaledAngle = (multiplier: number): number =>
    Number((BigInt(progress) * BigInt(multiplier)) / 256n) | 0;
  switch (easing) {
    case 1:
      return truncateInt32((nativeTrig((0xb40000 - scaledAngle(180)) | 0, true) + 1) * 32768);
    case 2:
      return truncateInt32(nativeTrig(scaledAngle(90), false) * 65536);
    case 3:
      return truncateInt32((1 - nativeTrig((0x5a0000 - scaledAngle(90)) | 0, false)) * 65536);
    default:
      if (easing >= 4 && easing <= 15) {
        const exponent = ([2, 2, 2.5, 2.5, 3, 3, 4, 4, 5, 5, 6, 6] as const)[easing - 4]!;
        const denominator = nativePower1665(0x1000000, exponent);
        if ((easing & 1) === 0)
          return truncateInt32((nativePower1665(progress, exponent) * 65536) / denominator);
        return truncateInt32(
          (1 - nativePower1665((0x1000000 - progress) | 0, exponent) / denominator) * 65536,
        );
      }
      return (progress + ((progress >> 31) & 0xff)) >> 8;
  }
}

/** 0041a450 negates the converted angle, then separately adds binary64 PI/2. */
export function native1665AffineSineCosine(fixedDegrees: number): {
  sine: number;
  cosine: number;
  perpendicularSine: number;
  perpendicularCosine: number;
} {
  const angle = -(((fixedDegrees | 0) * 3.141592653589793) / 11796480),
    perpendicular = angle + 1.5707963267948966;
  return {
    sine: nativeTrigRadians(angle, false),
    cosine: nativeTrigRadians(angle, true),
    perpendicularSine: nativeTrigRadians(perpendicular, false),
    perpendicularCosine: nativeTrigRadians(perpendicular, true),
  };
}

/** 0049d080 uses signed-Q8 degrees after wrapped unsigned progress division. */
export function native1665CursorInterpolation(
  delta: number,
  easing: number,
  progress: number,
  steps: number,
): number {
  delta |= 0;
  easing |= 0;
  progress >>>= 0;
  steps >>>= 0;
  if (steps === 0) throw new Error('Buriko native cursor interpolation division by zero');
  if (easing !== 1) return Math.imul(Math.floor(((progress << 16) >>> 0) / steps), delta) >> 16;
  const angle256 = (0xb400 - Math.floor((Math.imul(progress, 0xb400) >>> 0) / steps)) | 0;
  // The motion owner calls only before progress reaches steps, bounding this angle to 0..180.
  if (angle256 < 0 || angle256 > 0xb400)
    throw new RangeError(
      'Buriko 1.665 cursor interpolation exceeds its verified native motion domain',
    );
  const angle = (angle256 * 3.141592653589793) / 46080;
  return Math.imul(truncateInt32((nativeTrigRadians(angle, true) + 1) * 32768), delta) >> 16;
}

function divide32(dividend: number, divisor: number, remainder: boolean): number {
  if (dividend === -0x80000000 && divisor === -1)
    throw new Error('Buriko 1.665 native 32-bit division overflow');
  return divisor === 0 ? -1 : remainder ? dividend % divisor : Math.trunc(dividend / divisor);
}

function divide64(h: BurikoBpOpcodeContext, remainder: boolean): 0 {
  const right = pointer(h, pop32(h.thread)),
    left = pointer(h, pop32(h.thread));
  const destination = pointer(h, pop32(h.thread));
  const read = (p: ReturnType<typeof pointer>) => {
    const bytes = pointerBytes(p, 8);
    return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, true);
  };
  const divisor = read(right),
    dividend = read(left);
  if (divisor === 0n) throw new Error('Buriko 1.665 native 64-bit division by zero');
  const output = pointerBytes(destination, 8, 0, 'write');
  new DataView(output.buffer, output.byteOffset, 8).setBigInt64(
    0,
    BigInt.asIntN(64, remainder ? dividend % divisor : dividend / divisor),
    true,
  );
  return 0;
}

/** Differences from the later x64 compatibility 1.72 primary table.
 * Frame return floors, scalar selectors, encoding-aware text and SSE vector
 * instructions retain the shared implementations verified against the x86 table. */
export function createLegacy1665CoreOpcodes(): Readonly<Record<number, BurikoBpOpcodeHandler>> {
  return {
    0x09: (h) => {
      const value = popDeferred32(h.thread),
        address = pop32(h.thread);
      if (!h.diagnostics.writeWatchEnabled) pointer(h, address);
      const type = readU8(h.thread);
      if (h.diagnostics.writeWatchEnabled)
        h.diagnostics.checkWrite(h.thread, address, accessSize(type));
      writeDeferredScalar(h, address, type, value);
      if (value.reason === undefined) push32(h.thread, value.value);
      else pushIndeterminate32(h.thread, value.reason);
      return 0;
    },
    0x16: (h) => {
      const t = h.thread;
      // 00481db0 allows equality and wraps the unsigned DWORD addition first.
      if ((t.frameCursor + 4) >>> 0 > t.frameLimit)
        throw new Error('Buriko 1.665 call frame overflow');
      t.callSites.push(t.instructionStart);
      writeFrame32(t, t.frameCursor, (t.instructionStart + 1) >>> 0);
      t.frameCursor = (t.frameCursor + 4) >>> 0;
      const target = pop32(t);
      if (target === 0 || !validCodeAddress(t, target))
        throw new Error('Buriko 1.665 invalid code target');
      setPc(t, target);
      return 0;
    },
    0x1e: (h) => {
      const local = localDescriptor(h),
        value = pop32(h.thread) | 0;
      const divisor = readScalar(h, local.address, local.type);
      if (divisor === 0) throw new Error('Buriko 1.665 native 32-bit division by zero');
      push32(h.thread, divide32(value, divisor, false));
      return 0;
    },
    0x23: (h) => {
      const divisor = pop32(h.thread) | 0,
        dividend = pop32(h.thread) | 0;
      push32(h.thread, divide32(dividend, divisor, false));
      return 0;
    },
    0x24: (h) => {
      const divisor = pop32(h.thread) | 0,
        dividend = pop32(h.thread) | 0;
      push32(h.thread, divide32(dividend, divisor, true));
      return 0;
    },
    0x2f: (h) => {
      const divisor = readVarInt(h.thread) | 0,
        dividend = pop32(h.thread) | 0;
      push32(h.thread, divide32(dividend, divisor, false));
      return 0;
    },
    0x42: (h) => {
      const divisor = BigInt(pop32(h.thread) | 0),
        multiplier = BigInt(pop32(h.thread) | 0),
        value = BigInt(pop32(h.thread) | 0);
      if (divisor === 0n) throw new Error('Buriko 1.665 native 64-bit division by zero');
      push32(h.thread, Number(BigInt.asIntN(32, (value * multiplier) / divisor)));
      return 0;
    },
    0x43: (h) => {
      const y = pop32(h.thread) | 0,
        x = pop32(h.thread) | 0;
      push32(h.thread, native1665VectorAngle(x, y));
      return 0;
    },
    0x45: (h) => {
      const zAngle = pop32(h.thread) | 0,
        yAngle = pop32(h.thread) | 0,
        xAngle = pop32(h.thread) | 0;
      const source = pointer(h, pop32(h.thread)),
        destination = pointer(h, pop32(h.thread));
      const inputBytes = pointerBytes(source, 12),
        input = new DataView(inputBytes.buffer, inputBytes.byteOffset, 12);
      const x = input.getInt32(0, true),
        y = input.getInt32(4, true),
        z = input.getInt32(8, true);
      const sx = nativeTrig(xAngle, false),
        cx = nativeTrig(xAngle, true);
      const afterXy = cx * y - sx * z,
        afterXz = cx * z + sx * y;
      const sy = nativeTrig(yAngle, false),
        cy = nativeTrig(yAngle, true),
        afterYx = sy * afterXz + cy * x;
      const sz = nativeTrig(zAngle, false),
        cz = nativeTrig(zAngle, true);
      const outputBytes = pointerBytes(destination, 12, 0, 'write'),
        output = new DataView(outputBytes.buffer, outputBytes.byteOffset, 12);
      // floor 004ef660 followed by __ftol 004edc1c returns the low DWORD of int64.
      output.setInt32(0, Math.floor(cz * afterYx - sz * afterXy + 0.5) | 0, true);
      output.setInt32(4, Math.floor(cz * afterXy + sz * afterYx + 0.5) | 0, true);
      output.setInt32(8, Math.floor(cy * afterXz - sy * x + 0.5) | 0, true);
      return 0;
    },
    0x48: (h) => {
      push32(h.thread, truncateInt32(nativeTrig(pop32(h.thread), false) * 65536));
      return 0;
    },
    0x49: (h) => {
      push32(h.thread, truncateInt32(nativeTrig(pop32(h.thread), true) * 65536));
      return 0;
    },
    0x53: (h) => divide64(h, false),
    0x54: (h) => divide64(h, true),
    0x55: (h) => {
      const power = Math.fround(Math.fround(pop32(h.thread) | 0) / 65536);
      const base = Math.fround(Math.fround(pop32(h.thread) | 0) / 65536);
      push32(h.thread, fixedResult(Math.fround(nativePower1665(base, power))));
      return 0;
    },
  };
}

// Exact binary64 constants from verified jeweha.exe, SHA-256 3479a25c41ab868732cebbd5c9f70d485ee2082acdee708770f7ff642cbd03a1.

/** Native 0x51bab0, 16 binary64 entries. */
const atanLong = decodeWords(`
3fd5555555555552 0000000000000000 3fc249249246aa76 bfc99999999992ac
3fb745d15933de8a bfbc71c71b835923 3fb110f5eeb76eca bfb3b1390a3b9899
3faae4492fe3a600 bfae1c1704144b68 3fa51fa164891abe bfa8171d55d53138
3f974721481ca2a2 bfa124ce2388f2cb 3f66107c30e0b8a5 bf866e5652b14bbd
`);

/** Native 0x51bb30, 8 binary64 entries. */
const atanShort = decodeWords(`
3fd55555555554eb 0000000000000000 3fc249249014497e bfc9999999976718
3fb7453ba342480f bfbc71c4eebfb10e 3fae9be97b0f8d08 bfb39ad683f878c6
`);

/** Native 0x51bff8, 771 binary64 entries. */
const atanReduction = decodeWords(`
3f9ffd55b8000000 3ded4bb12542779d 3fa0000000000000 3faff55bb4000000
3df967ef4e36cb28 3fb0000000000000 3fb7ee1824000000 3e00178874609356
3fb8000000000000 3fbfd5ba98000000 3e05617b6e32c898 3fc0000000000000
3fc3d6eee8000000 3df8cc4d8b0d1d86 3fc4000000000000 3fc7b97b48000000
3e1e72d811347b0b 3fc8000000000000 3fcb90d750000000 3e1493051022f622
3fcc000000000000 3fcf5b75f8000000 3e02c80dd62adb8f 3fd0000000000000
3fd18bf5a0000000 3e285f8bc130ca47 3fd2000000000000 3fd3627734000000
3e283f5e5e69c5ac 3fd4000000000000 3fd530ad98000000 3e151cd49db53370
3fd6000000000000 3fd6f61940000000 3e1e4def08e71546 3fd8000000000000
3fd8b24d38000000 3e14a1b256db42e9 3fda000000000000 3fda64eec0000000
3e2e611fe5b6427d 3fdc000000000000 3fdc0db4c8000000 3e14ec9ef8cf8c64
3fde000000000000 3fddac6704000000 3e161bb4f68adfc9 3fe0000000000000
3fdf40dd08000000 3e2aa0a0be5c66d2 3fe1000000000000 3fe0657e94000000
3e1b6619f8a92da8 3fe2000000000000 3fe1255d98000000 3e3fde9547b50944
3fe3000000000000 3fe1e00ba8000000 3e3ef7f59f9b5c83 3fe4000000000000
3fe2958e58000000 3e2308e30dec318a 3fe5000000000000 3fe345f01c000000
3e19c6f76881089c 3fe6000000000000 3fe3f13fb8000000 3e13d2de87b3e2d2
3fe7000000000000 3fe4978fa0000000 3e3934f7092419a8 3fe8000000000000
3fe538f578000000 3e3c4830f5c8916b 3fe9000000000000 3fe5d58984000000
3e38b4d8c0801472 3fea000000000000 3fe66d6638000000 3e223e086d22b203
3feb000000000000 3fe700a7c4000000 3e2784633ce7965b 3fec000000000000
3fe78f6bbc000000 3e25d315e501a822 3fed000000000000 3fe819d0b4000000
3e38ac52664089dd 3fee000000000000 3fe89ff5fc000000 3e3abf8fbd548cb4
3fef000000000000 3fe921fb54000000 3e010b4611a62633 3ff0000000000000
3fe9a000a8000000 3e235bd8e2b2823c 3ff0800000000000 3fea1a25f0000000
3e3641282f3a59e5 3ff1000000000000 3fea908af8000000 3e32d8ea4ea2841a
3ff1800000000000 3feb034f38000000 3e092721e4177297 3ff2000000000000
3feb7291b4000000 3e1c4b7b38ed8cf6 3ff2800000000000 3febde70ec000000
3e2439fe6cba9539 3ff3000000000000 3fec470abc000000 3e3969e8096a61dc
3ff3800000000000 3fecac7c54000000 3e3c237cf21b5c27 3ff4000000000000
3fed0ee224000000 3e23886a64b27dce 3ff4800000000000 3fed6e57cc000000
3e3a78564d1388d7 3ff5000000000000 3fedcaf82c000000 3e2c1a6f38198d31
3ff5800000000000 3fee24dd44000000 3e190aba2fbd6309 3ff6000000000000
3fee7c2040000000 3e31a87c3778f594 3ff6800000000000 3feed0d97c000000
3e1208391ed9d61c 3ff7000000000000 3fef232070000000 3e3d758b8d41498c
3ff7800000000000 3fef730bd0000000 3e340fb4d9007888 3ff8000000000000
3fefc0b170000000 3e2ec926bf666465 3ff8800000000000 3ff006132c000000
3e41a6b0bb6687bf 3ff9000000000000 3ff02abf68000000 3e32f6d0ba07f176
3ff9800000000000 3ff04e6724000000 3e4bd00eb85c4552 3ffa000000000000
3ff07113c4000000 3e4549d108e15e27 3ffa800000000000 3ff092ce44000000
3e48c29e61269f9b 3ffb000000000000 3ff0b39f4c000000 3e46511d724b268b
3ffb800000000000 3ff0d38f2c000000 3e16e827a42f23dd 3ffc000000000000
3ff0f2a5d8000000 3e3fff0263cd585d 3ffc800000000000 3ff110eb00000000
3e1fce7daed4d008 3ffd000000000000 3ff12e65f8000000 3e419557641b49ef
3ffd800000000000 3ff14b1dd4000000 3e3f90ce0eded2a9 3ffe000000000000
3ff1671958000000 3e4101932a34b594 3ffe800000000000 3ff1825f04000000
3e4a0186c7cd5b82 3fff000000000000 3ff19cf518000000 3e48301ee6b48631
3fff800000000000 3ff1b6e190000000 3e475df2236368cd 4000000000000000
3ff1d02a2c000000 3e46e70a78e851d9 4000400000000000 3ff1e8d470000000
3e4e2eae52816b65 4000800000000000 3ff200e5ac000000 3e406eb0e9bed3ce
4000c00000000000 3ff21862f0000000 3e4fd6f1b2910ec5 4001000000000000
3ff22f5124000000 3e4ffb85a94a430e 4001400000000000 3ff245b4f8000000
3e4791888486a48c 4001800000000000 3ff25b92ec000000 3e417bd24514338e
4001c00000000000 3ff270ef54000000 3e3a53a249665394 4002000000000000
3ff285ce58000000 3e3c9731fa293642 4002400000000000 3ff29a33f8000000
3e37bdbea481da3e 4002800000000000 3ff2ae2408000000 3e4e991ca4052873
4002c00000000000 3ff2c1a240000000 3e3d66dc360acb56 4003000000000000
3ff2d4b228000000 3e01d1ae0e7bd892 4003400000000000 3ff2e75728000000
3e20674a822dc7df 4003800000000000 3ff2f99488000000 3e4b50da6122febc
4003c00000000000 3ff30b6d78000000 3e36a4da8589532c 4004000000000000
3ff31ce4fc000000 3e226268e9cd3682 4004400000000000 3ff32dfe00000000
3e3c11c2172c6bce 4004800000000000 3ff33ebb58000000 3e3df782abf530b1
4004c00000000000 3ff34f1fb8000000 3e48cf584980d79b 4005000000000000
3ff35f2dc0000000 3e400a0dd417c1d8 4005400000000000 3ff36ee7f0000000
3e4512321da6fbed 4005800000000000 3ff37e50b8000000 3e38fe91c5f13d98
4005c00000000000 3ff38d6a6c000000 3e2c266a5bb4e206 4006000000000000
3ff39c374c000000 3e3238f7af78f7a2 4006400000000000 3ff3aab984000000
3e420f935623cb63 4006800000000000 3ff3b8f330000000 3e1859ea2ea8da37
4006c00000000000 3ff3c6e650000000 3e267008eb5b1d9b 4007000000000000
3ff3d494d8000000 3e41f8ee4d8c3468 4007400000000000 3ff3e200ac000000
3e45006cc570d645 4007800000000000 3ff3ef2b9c000000 3e45ef249a156fa4
4007c00000000000 3ff3fc1768000000 3e4bd42affebbe5c 4008000000000000
3ff408c5c4000000 3e42c5bb163f992d 4008400000000000 3ff4153850000000
3e40d97cc06c2894 4008800000000000 3ff42170a0000000 3e4ae340d1e5c775
4008c00000000000 3ff42d7040000000 3e31f9ec125611b7 4009000000000000
3ff43938a4000000 3e35b4f1d47fe5a1 4009400000000000 3ff444cb3c000000
3e37d780c613b6f7 4009800000000000 3ff4502968000000 3e474fca44605208
4009c00000000000 3ff45b5480000000 3e4b9a8d00cf2539 400a000000000000
3ff4664dd0000000 3e3ce02f94e3b319 400a400000000000 3ff4711694000000
3e3fedde1d92c3bc 400a800000000000 3ff47bb004000000 3e3c4732d68be634
400ac00000000000 3ff4861b4c000000 3e2f7ce1fea982c3 400b000000000000
3ff490598c000000 3e400af173c0fbdf 400b400000000000 3ff49a6be0000000
3e4061d292c3f0d9 400b800000000000 3ff4a45358000000 3e38759bfd332878
400bc00000000000 3ff4ae10fc000000 3e1962692c4fc176 400c000000000000
3ff4b7a5c8000000 3e4392cd4c26fe1b 400c400000000000 3ff4c112b8000000
3e4cfbe3187dd199 400c800000000000 3ff4ca58c0000000 3e13b78c88a26f4c
400cc00000000000 3ff4d378c0000000 3e3999a0cf1bd42d 400d000000000000
3ff4dc73a0000000 3e393f1b44494636 400d400000000000 3ff4e54a38000000
3e4c7367beab998c 400d800000000000 3ff4edfd64000000 3e151079a0981511
400dc00000000000 3ff4f68de8000000 3e433930bb269f3e 400e000000000000
3ff4fefc94000000 3e41c53cfb940a04 400e400000000000 3ff5074a28000000
3e430956168f4910 400e800000000000 3ff50f7760000000 3e4ea540045e84bb
400ec00000000000 3ff51784f8000000 3e40aa25cdb92387 400f000000000000
3ff51f739c000000 3e4b1efb4d960003 400f400000000000 3ff5274400000000
3e2dd4e551b9aece 400f800000000000 3ff52ef6c4000000 3e47eea8b4210b39
400fc00000000000 3ff5368c94000000 3e31e9cfc9a42e1b 4010000000000000
3ff53e0608000000 3e42634e9107312e 4010200000000000 3ff54563c0000000
3e318794c773e215 4010400000000000 3ff54ca64c000000 3e4e7f48e86e8702
4010600000000000 3ff553ce48000000 3e2408ec981357a9 4010800000000000
3ff55adc38000000 3e3bab71a782c80a 4010a00000000000 3ff561d0ac000000
3e375b852ff61d4e 4010c00000000000 3ff568ac28000000 3e436d1ca43d8916
4010e00000000000 3ff56f6f30000000 3e4d1f3537104891 4011000000000000
3ff5761a48000000 3e23a2142ec6b750 4011200000000000 3ff57cade4000000
3e37dba50fe7479a 4011400000000000 3ff5832a80000000 3e4932bb843423ed
4011600000000000 3ff5899094000000 3e4a6fe4d58f1b6f 4011800000000000
3ff58fe094000000 3e2384a92ddbf7f0 4011a00000000000 3ff5961ae8000000
3e460c2594a368d4 4011c00000000000 3ff59c4004000000 3e447f5e78ab521e
4011e00000000000 3ff5a25050000000 3e408a7300c61686 4012000000000000
3ff5a84c34000000 3e23be0a215f8f50 4012200000000000 3ff5ae3410000000
3e478e233a83e4ac 4012400000000000 3ff5b4084c000000 3e4a08263a8e6771
4012600000000000 3ff5b9c948000000 3e34c0d72e244c35 4012800000000000
3ff5bf775c000000 3e43940431bd210b 4012a00000000000 3ff5c512e8000000
3e3c5bb9e8c1c10c 4012c00000000000 3ff5ca9c44000000 3dfaa57fd53cbaae
4012e00000000000 3ff5d013c4000000 3dfadabd7e0aee86 4013000000000000
3ff5d579bc000000 3e42a9fee487fcab 4013200000000000 3ff5dace84000000
3e34dff1c02e7eb5 4013400000000000 3ff5e01268000000 3e38df7c9a75fae2
4013600000000000 3ff5e545b8000000 3e3b1a4c79381d41 4013800000000000
3ff5ea68c0000000 3e43bbfd3134acc0 4013a00000000000 3ff5ef7bcc000000
3e466f2bd383f92d 4013c00000000000 3ff5f47f24000000 3e4f0412f8939478
4013e00000000000 3ff5f97314000000 3e3254856d9dd5cb 4014000000000000
3ff5fe57dc000000 3e1a3d8504f0de87 4014200000000000 3ff6032dc0000000
3e3db31f5cdeaec3 4014400000000000 3ff607f508000000 3dfa3d5ccafdcb05
4014600000000000 3ff60cadf0000000 3e0f22265c6a071c 4014800000000000
3ff61158b8000000 3e3e44d231f90cbe 4014a00000000000 3ff615f5a0000000
3e49c660234f23f5 4014c00000000000 3ff61a84e8000000 3e301dd7838c7d99
4014e00000000000 3ff61f06c4000000 3e45495c46b782af 4015000000000000
3ff6237b74000000 3e422c04afd7a5ff 4015200000000000 3ff627e330000000
3e24815d20954589 4015400000000000 3ff62c3e2c000000 3e35153f86deec92
4015600000000000 3ff6308ca0000000 3e450f714969afbb 4015800000000000
3ff634cec4000000 3e3badbbf36168e6 4015a00000000000 3ff63904c8000000
3e44cd8c90418df9 4015c00000000000 3ff63d2ee4000000 3dfc77ff464ba4cc
4015e00000000000 3ff6414d44000000 3de298f71d04facd 4016000000000000
3ff6456018000000 3e48ae3049917061 4016200000000000 3ff6496798000000
3e2dc3d89d3a99a4 4016400000000000 3ff64d63ec000000 3e0e12511525f2a5
4016600000000000 3ff6515540000000 3e456f9ada35794c 4016800000000000
3ff6553bc8000000 3e2f8f30a067da76 4016a00000000000 3ff65917a8000000
3e478e550cde766a 4016c00000000000 3ff65ce910000000 3e4b79ffe3d2e7d0
4016e00000000000 3ff660b02c000000 3e1cda81794d2541 4017000000000000
3ff6646d1c000000 3e48fe9ea5eefbf0 4017200000000000 3ff6682010000000
3e4df4d31fcd70c1 4017400000000000 3ff66bc930000000 3e3c7d911c0eee6b
4017600000000000 3ff66f689c000000 3e4f3766b894b59d 4017800000000000
3ff672fe80000000 3e4ffc7d02f89b98 4017a00000000000 3ff6768b00000000
3e4996690df5852b 4017c00000000000 3ff67a0e40000000 3e3e3d2742f162eb
4017e00000000000 3ff67d8860000000 3e4de4cde4c9085a 4018000000000000
3ff680f988000000 3e4d939889f0ae31 4018200000000000 3ff68461dc000000
3de4d78d157ee252 4018400000000000 3ff687c174000000 3e42ecaa09544e51
4018600000000000 3ff68b1878000000 3e4ce963043357d6 4018800000000000
3ff68e670c000000 3df6a28a9e282be5 4018a00000000000 3ff691ad44000000
3e4bbc4ac2c88d71 4018c00000000000 3ff694eb4c000000 3e2a2c3b001d18c8
4018e00000000000 3ff6982138000000 3e44ea82948cf8df 4019000000000000
3ff69b4f2c000000 3e45fdabbef520cb 4019200000000000 3ff69e7544000000
3e445d6e69f296ef 4019400000000000 3ff6a1939c000000 3e4633c1938e9425
4019600000000000 3ff6a4aa50000000 3e4d562246bc8e5e 4019800000000000
3ff6a7b980000000 3e2d7d30339b7d85 4019a00000000000 3ff6aac140000000
3e3b907909467e87 4019c00000000000 3ff6adc1b0000000 3e28021f521e096c
4019e00000000000 3ff6b0bae8000000 3e086037d05ca8fa 401a000000000000
3ff6b3ad00000000 3e3bf799b4676489 401a200000000000 3ff6b69814000000
3e4540b076533be1 401a400000000000 3ff6b97c3c000000 3e4d84f71fc8ea98
401a600000000000 3ff6bc5994000000 3e32bf3b11977d7c 401a800000000000
3ff6bf302c000000 3e47e2fb0c763ca6 401aa00000000000 3ff6c20024000000
3e22c3702f81afcc 401ac00000000000 3ff6c4c98c000000 3e301c285cfffb93
401ae00000000000 3ff6c78c7c000000 3e46f58cab24735b 401b000000000000
3ff6ca4910000000 3e195694d38764ab 401b200000000000 3ff6ccff54000000
3e4b4c2930a4adba 401b400000000000 3ff6cfaf68000000 3e35c847358f29f7
401b600000000000 3ff6d25958000000 3e4a7aca1ada7c8a 401b800000000000
3ff6d4fd40000000 3e3f4c9bbedeb557 401ba00000000000 3ff6d79b30000000
3e3a369de9f9da8d 401bc00000000000 3ff6da333c000000 3e42bcb7925188a0
401be00000000000 3ff6dcc578000000 3e4dab2fe5ac6f37 401c000000000000
3ff6df51fc000000 3e30a85ada634ba7 401c200000000000 3ff6e1d8d4000000
3e350141972d7afb 401c400000000000 3ff6e45a14000000 3e496344f1054222
401c600000000000 3ff6e6d5d4000000 3e2e9a4960de1ed7 401c800000000000
3ff6e94c20000000 3e25e96402f41f4c 401ca00000000000 3ff6ebbd0c000000
3df42077226cd722 401cc00000000000 3ff6ee28a8000000 3e21f21cd73fb01a
401ce00000000000 3ff6f08f04000000 3e4a1aff5e6a858f 401d000000000000
3ff6f2f038000000 3e3085fa489ecf00 401d200000000000 3ff6f54c4c000000
3e437f8725a7829a 401d400000000000 3ff6f7a354000000 3e4e2bcf4ac31fa1
401d600000000000 3ff6f9f564000000 3e30fd3ef66c1c3b 401d800000000000
3ff6fc4284000000 3e40957f767b5ea8 401da00000000000 3ff6fe8ac8000000
3e427f95cb5940fa 401dc00000000000 3ff700ce40000000 3e30908bb26c8754
401de00000000000 3ff7030cf8000000 3e3403196e341e77 401e000000000000
3ff7054700000000 3e3b9c3d9a4e6f96 401e200000000000 3ff7077c68000000
3e2fad1f7bd24cfe 401e400000000000 3ff709ad3c000000 3e35751e6e8b1342
401e600000000000 3ff70bd98c000000 3e2b2c8660d4b2fd 401e800000000000
3ff70e0164000000 3e35c6050be5b49a 401ea00000000000 3ff71024d4000000
3e202019d6b1016c 401ec00000000000 3ff71243e4000000 3e4d88975e2b7f7e
401ee00000000000 3ff7145eac000000 3e004451c04b50d1 401f000000000000
3ff716752c000000 3e4674230fe87b5e 401f200000000000 3ff718877c000000
3e20cbd14b345ee3 401f400000000000 3ff71a95a0000000 3e3e0a4fa234ee85
401f600000000000 3ff71c9fa8000000 3e4a20a593da4558 401f800000000000
3ff71ea5a4000000 3e2cd1b9d467c728 401fa00000000000 3ff720a798000000
3e46700f732d3334 401fc00000000000 3ff722a598000000 3e2a2ba735456050
401fe00000000000 3ff7249fa8000000 3e44cb510b51983d 4020000000000000
3ff921fb54442d18 3c91a62633145c07 0000000000000000
`);

/** Native 0x51d820, 256 binary64 entries. */
const trigReduction = decodeWords(`
0000000000000000 0000000000000000 0000000000000000 3ff0000000000000
bf73b92e176d6d31 3fb917a6bc29b42c bc3e2718e0000000 3ff0000000000000
bf93ad06011469fb 3fc8f8b83c69a60b bc626d19c0000000 3ff0000000000000
bfa60bea939d225a 3fd294062ed59f06 bc75d28da0000000 3ff0000000000000
bfb37ca1866b95cf 3fd87de2a6aea963 bc672cede0000000 3ff0000000000000
bfbe3a6873fa1279 3fde2b5d3806f63b 3c5e0d8920000000 3ff0000000000000
bfc592675bc57974 3fe1c73b39ae68c8 3c8b25dd20000000 3ff0000000000000
bfcd0dfe53aba2fd 3fe44cf325091dd6 3c68076a20000000 3ff0000000000000
3fca827999fcef32 3fe6a09e667f3bcd bc8bdd3420000000 3fe0000000000000
3fc133cc94247758 3fe8bc806b151741 bc82c5e120000000 3fe0000000000000
3fac73b39ae68c87 3fea9b66290ea1a3 3c39f630e0000000 3fe0000000000000
bf9d4a2c7f909c4e 3fec38b2f180bdb1 bc76e0b180000000 3fe0000000000000
bfbe087565455a75 3fed906bcf328d46 3c7457e620000000 3fe0000000000000
3fa4a03176acf82d 3fee9f4156c62dda 3c8760b1e0000000 3fd0000000000000
bfac1d1f0e5967d5 3fef6297cff75cb0 3c75621720000000 3fd0000000000000
bf9ba1650f592f50 3fefd88da3d12526 bc887df640000000 3fc0000000000000
0000000000000000 3ff0000000000000 0000000000000000 0000000000000000
3f9ba1650f592f50 3fefd88da3d12526 bc887df640000000 bfc0000000000000
3fac1d1f0e5967d5 3fef6297cff75cb0 3c75621720000000 bfd0000000000000
bfa4a03176acf82d 3fee9f4156c62dda 3c8760b1e0000000 bfd0000000000000
3fbe087565455a75 3fed906bcf328d46 3c7457e620000000 bfe0000000000000
3f9d4a2c7f909c4e 3fec38b2f180bdb1 bc76e0b180000000 bfe0000000000000
bfac73b39ae68c87 3fea9b66290ea1a3 3c39f630e0000000 bfe0000000000000
bfc133cc94247758 3fe8bc806b151741 bc82c5e120000000 bfe0000000000000
bfca827999fcef32 3fe6a09e667f3bcd bc8bdd3420000000 bfe0000000000000
3fcd0dfe53aba2fd 3fe44cf325091dd6 3c68076a20000000 bff0000000000000
3fc592675bc57974 3fe1c73b39ae68c8 3c8b25dd20000000 bff0000000000000
3fbe3a6873fa1279 3fde2b5d3806f63b 3c5e0d8920000000 bff0000000000000
3fb37ca1866b95cf 3fd87de2a6aea963 bc672cede0000000 bff0000000000000
3fa60bea939d225a 3fd294062ed59f06 bc75d28da0000000 bff0000000000000
3f93ad06011469fb 3fc8f8b83c69a60b bc626d19c0000000 bff0000000000000
3f73b92e176d6d31 3fb917a6bc29b42c bc3e2718e0000000 bff0000000000000
0000000000000000 0000000000000000 0000000000000000 bff0000000000000
3f73b92e176d6d31 bfb917a6bc29b42c 3c3e2718e0000000 bff0000000000000
3f93ad06011469fb bfc8f8b83c69a60b 3c626d19c0000000 bff0000000000000
3fa60bea939d225a bfd294062ed59f06 3c75d28da0000000 bff0000000000000
3fb37ca1866b95cf bfd87de2a6aea963 3c672cede0000000 bff0000000000000
3fbe3a6873fa1279 bfde2b5d3806f63b bc5e0d8920000000 bff0000000000000
3fc592675bc57974 bfe1c73b39ae68c8 bc8b25dd20000000 bff0000000000000
3fcd0dfe53aba2fd bfe44cf325091dd6 bc68076a20000000 bff0000000000000
bfca827999fcef32 bfe6a09e667f3bcd 3c8bdd3420000000 bfe0000000000000
bfc133cc94247758 bfe8bc806b151741 3c82c5e120000000 bfe0000000000000
bfac73b39ae68c87 bfea9b66290ea1a3 bc39f630e0000000 bfe0000000000000
3f9d4a2c7f909c4e bfec38b2f180bdb1 3c76e0b180000000 bfe0000000000000
3fbe087565455a75 bfed906bcf328d46 bc7457e620000000 bfe0000000000000
bfa4a03176acf82d bfee9f4156c62dda bc8760b1e0000000 bfd0000000000000
3fac1d1f0e5967d5 bfef6297cff75cb0 bc75621720000000 bfd0000000000000
3f9ba1650f592f50 bfefd88da3d12526 3c887df640000000 bfc0000000000000
0000000000000000 bff0000000000000 0000000000000000 0000000000000000
bf9ba1650f592f50 bfefd88da3d12526 3c887df640000000 3fc0000000000000
bfac1d1f0e5967d5 bfef6297cff75cb0 bc75621720000000 3fd0000000000000
3fa4a03176acf82d bfee9f4156c62dda bc8760b1e0000000 3fd0000000000000
bfbe087565455a75 bfed906bcf328d46 bc7457e620000000 3fe0000000000000
bf9d4a2c7f909c4e bfec38b2f180bdb1 3c76e0b180000000 3fe0000000000000
3fac73b39ae68c87 bfea9b66290ea1a3 bc39f630e0000000 3fe0000000000000
3fc133cc94247758 bfe8bc806b151741 3c82c5e120000000 3fe0000000000000
3fca827999fcef32 bfe6a09e667f3bcd 3c8bdd3420000000 3fe0000000000000
bfcd0dfe53aba2fd bfe44cf325091dd6 bc68076a20000000 3ff0000000000000
bfc592675bc57974 bfe1c73b39ae68c8 bc8b25dd20000000 3ff0000000000000
bfbe3a6873fa1279 bfde2b5d3806f63b bc5e0d8920000000 3ff0000000000000
bfb37ca1866b95cf bfd87de2a6aea963 3c672cede0000000 3ff0000000000000
bfa60bea939d225a bfd294062ed59f06 3c75d28da0000000 3ff0000000000000
bf93ad06011469fb bfc8f8b83c69a60b 3c626d19c0000000 3ff0000000000000
bf73b92e176d6d31 bfb917a6bc29b42c 3c3e2718e0000000 3ff0000000000000
`);
