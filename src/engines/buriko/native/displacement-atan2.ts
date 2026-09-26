import {displacementAtanHead, displacementAtanTail} from './displacement-atan2-tables.js';
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

/** 1436E8 restricted to the exact signed-DWORD inputs of033EC0/033B60. */
export function nativeDisplacementIntegerAtan2(y: number, x: number): number {
  y |= 0;
  x |= 0;
  if (y === 0) return x < 0 ? 3.141592653589793 : 0;
  if (x === 0) return y < 0 ? -1.5707963267948966 : 1.5707963267948966;
  if (exponent(y) - exponent(x) < -28 && x > 0) return y / x;
  let small = Math.abs(y),
    large = Math.abs(x);
  const swapped = small > large;
  if (swapped) [small, large] = [large, small];
  const ratio = small / large;
  let head = 0,
    tail = ratio;
  if (ratio <= 0.0625) {
    if (ratio >= 1e-8) {
      const square = ratio * ratio;
      const largeHigh = number(bits(large) & 0xffffffff00000000n),
        ratioHigh = number(bits(ratio) & 0xffffffff00000000n);
      const error =
        (small -
          ratioHigh * largeHigh -
          (large - largeHigh) * ratioHigh -
          (ratio - ratioHigh) * large) /
        large;
      const a = 0.11110736283514526 - square * 0.09002981028544979;
      const b = 0.1428571356180717 - a * square;
      const c = 0.19999999999393223 - b * square;
      const d = 0.3333333333333317 - c * square;
      const cube = square * ratio;
      tail = ratio + (error - d * cube);
    }
  } else {
    const n = Math.trunc(ratio * 256 + 0.5),
      index = n - 16,
      anchor = n / 256;
    head = number(displacementAtanHead[index]!);
    const tableTail = number(displacementAtanTail[index]!);
    const adjustment = 1023 - exponent(large),
      first = Math.trunc(adjustment / 2),
      second = adjustment - first;
    const powerA = number(BigInt(first + 1023) << 52n),
      powerB = number(BigInt(second + 1023) << 52n);
    const scaledLarge = powerA * large * powerB,
      scaledSmall = powerA * small * powerB;
    const high = number(bits(scaledLarge) & 0xfffffffff8000000n);
    const residual =
      (scaledSmall - high * anchor - (scaledLarge - high) * anchor) /
      (anchor * scaledSmall + scaledLarge);
    const square = residual * residual;
    tail =
      residual +
      tableTail -
      (0.33333333333224097 - square * 0.19999918038989142) * square * residual;
  }
  if (swapped) {
    head = 1.5707963267948966 - head;
    tail = 6.123233995736766e-17 - tail;
  }
  if (x < 0) {
    head = 3.1415926218032837 - head;
    tail = 3.178650954705639e-8 - tail;
  }
  const result = head + tail;
  return y < 0 ? -result : result;
}
