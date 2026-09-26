/** Windows character-type profile used by this title's linked wide CRT parsers. */
export function aokanaCrtWideSpace(character: number): boolean {
  if (character < 0x100)
    return (
      (character >= 9 && character <= 13) ||
      character === 0x20 ||
      character === 0x85 ||
      character === 0xa0
    );
  // Modern Win32 C1_SPACE profile; the executable itself does not pin an OS Unicode version.
  return (
    character === 0x1680 ||
    (character >= 0x2000 && character <= 0x200a) ||
    character === 0x2028 ||
    character === 0x2029 ||
    character === 0x202f ||
    character === 0x205f ||
    character === 0x3000
  );
}

const digitBlocks = [
  0x30, 0x660, 0x6f0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xc66, 0xce6, 0xd66, 0xe50, 0xed0, 0xf20,
  0x1040, 0x17e0, 0x1810, 0xff10,
] as const;

/** The native CRT contains this fixed digit set, independently of the locale's case tables. */
export function aokanaCrtWideDigit(character: number): number {
  for (const first of digitBlocks)
    if (character >= first && character < first + 10) return character - first;
  if (character >= 0x41 && character <= 0x5a) return character - 0x37;
  if (character >= 0x61 && character <= 0x7a) return character - 0x57;
  return -1;
}

function wchar(text: string, index: number): number {
  return text.charCodeAt(index) || 0;
}

export interface AokanaCrtIntegerResult {
  readonly value: number;
  readonly end: number;
  readonly rangeError: boolean;
}

/** 14001d028 through wcstol/wcstoul; result retains the native DWORD bits. */
export function parseAokanaCrtWideInteger(
  text: string,
  base: 10 | 16,
  signed: boolean,
): AokanaCrtIntegerResult {
  let index = 0;
  while (aokanaCrtWideSpace(wchar(text, index))) index++;
  const negative = wchar(text, index) === 45;
  if (negative || wchar(text, index) === 43) index++;
  if (
    base === 16 &&
    aokanaCrtWideDigit(wchar(text, index)) === 0 &&
    (wchar(text, index + 1) === 88 || wchar(text, index + 1) === 120)
  )
    index += 2;
  const firstDigit = index;
  let magnitude = 0n;
  let overflow = false;
  for (;;) {
    const digit = aokanaCrtWideDigit(wchar(text, index));
    if (digit < 0 || digit >= base) break;
    index++;
    if (!overflow) {
      magnitude = magnitude * BigInt(base) + BigInt(digit);
      overflow = magnitude > 0xffffffffn;
    }
  }
  if (index === firstDigit) return {value: 0, end: 0, rangeError: false};
  const maximum = signed ? (negative ? 0x80000000n : 0x7fffffffn) : 0xffffffffn;
  overflow ||= magnitude > maximum;
  if (overflow)
    return {
      value: signed ? (negative ? 0x80000000 : 0x7fffffff) : 0xffffffff,
      end: index,
      rangeError: true,
    };
  return {
    value: Number(BigInt.asUintN(32, negative ? -magnitude : magnitude)),
    end: index,
    rangeError: false,
  };
}

export interface AokanaCrtFloatResult {
  readonly value: number;
  readonly bits: bigint;
  readonly end: number;
  readonly rangeError: boolean;
}

function floating(bits: bigint, end: number, rangeError = false): AokanaCrtFloatResult {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, bits, true);
  return {value: view.getFloat64(0, true), bits, end, rangeError};
}

/** Convert the retained exact mantissa to binary64, using the native initial nearest/even mode. */
function rationalBits(numerator: bigint, denominator: bigint): {bits: bigint; rangeError: boolean} {
  let exponent = numerator.toString(2).length - denominator.toString(2).length;
  if (
    exponent >= 0
      ? numerator < denominator << BigInt(exponent)
      : numerator << BigInt(-exponent) < denominator
  )
    exponent--;
  if (exponent > 1023) return {bits: 0x7ff0000000000000n, rangeError: true};
  if (exponent < -1075) return {bits: 0n, rangeError: true};
  const unitExponent = Math.max(exponent - 52, -1074);
  if (unitExponent < 0) numerator <<= BigInt(-unitExponent);
  else denominator <<= BigInt(unitExponent);
  let mantissa = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n > denominator || (remainder * 2n === denominator && (mantissa & 1n) !== 0n))
    mantissa++;
  if (exponent < -1022) return {bits: mantissa, rangeError: mantissa === 0n};
  if (mantissa === 0x20000000000000n) {
    mantissa >>= 1n;
    exponent++;
  }
  if (exponent > 1023) return {bits: 0x7ff0000000000000n, rangeError: true};
  return {
    bits: (BigInt(exponent + 1023) << 52n) | (mantissa & 0xfffffffffffffn),
    rangeError: false,
  };
}

/** 14001e2e4 and special-token helpers; mantissa retention is exactly 768 digits. */
export function parseAokanaCrtWideFloat(text: string): AokanaCrtFloatResult {
  let index = 0;
  while (aokanaCrtWideSpace(wchar(text, index))) index++;
  const negative = wchar(text, index) === 45;
  const sign = negative ? 0x8000000000000000n : 0n;
  if (negative || wchar(text, index) === 43) index++;
  const tokenStart = index;
  const matches = (token: string): boolean => {
    for (let offset = 0; offset < token.length; offset++) {
      const code = wchar(text, index);
      if (code !== token.charCodeAt(offset) && code !== token.toLowerCase().charCodeAt(offset))
        return false;
      index++;
    }
    return true;
  };
  if (wchar(text, index) === 73 || wchar(text, index) === 105) {
    if (!matches('INF')) return floating(0n, 0);
    const shortEnd = index;
    if (!matches('INITY')) index = shortEnd;
    return floating(sign | 0x7ff0000000000000n, index);
  }
  if (wchar(text, index) === 78 || wchar(text, index) === 110) {
    if (!matches('NAN')) return floating(0n, 0);
    const shortEnd = index;
    if (wchar(text, index) === 40) {
      index++;
      // Each failed native special matcher keeps the prefix it already consumed.
      if (matches('SNAN)')) return floating(sign | 0x7ff0000000000001n, index);
      if (matches('IND)')) return floating(0xfff8000000000000n, index);
      while (wchar(text, index) !== 41) {
        const code = wchar(text, index);
        if (!(
          (code >= 48 && code <= 57) ||
          (code >= 65 && code <= 90) ||
          (code >= 97 && code <= 122) ||
          code === 95
        ))
          return floating(sign | 0x7fffffffffffffffn, shortEnd);
        index++;
      }
      index++;
    }
    return floating(sign | 0x7fffffffffffffffn, index);
  }
  const hexadecimal =
    wchar(text, index) === 48 && (wchar(text, index + 1) === 88 || wchar(text, index + 1) === 120);
  if (hexadecimal) index += 2;
  let anyDigit = false;
  while (wchar(text, index) === 48) {
    anyDigit = true;
    index++;
  }
  const digits: number[] = [];
  let integerDigits = 0;
  const base = hexadecimal ? 16 : 10;
  for (;;) {
    const digit = aokanaCrtWideDigit(wchar(text, index));
    if (digit < 0 || digit >= base) break;
    anyDigit = true;
    if (digits.length < 768) digits.push(digit);
    integerDigits = (integerDigits + 1) | 0;
    index++;
  }
  if (wchar(text, index) === 46) {
    index++;
    if (digits.length === 0)
      while (wchar(text, index) === 48) {
        anyDigit = true;
        integerDigits = (integerDigits - 1) | 0;
        index++;
      }
    for (;;) {
      const digit = aokanaCrtWideDigit(wchar(text, index));
      if (digit < 0 || digit >= base) break;
      anyDigit = true;
      if (digits.length < 768) digits.push(digit);
      index++;
    }
  }
  if (!anyDigit) return hexadecimal ? floating(sign, tokenStart + 1) : floating(0n, 0);
  let exponent = 0;
  const exponentLetter = wchar(text, index);
  if (
    hexadecimal
      ? exponentLetter === 80 || exponentLetter === 112
      : exponentLetter === 69 || exponentLetter === 101
  ) {
    const exponentStart = index++;
    const exponentNegative = wchar(text, index) === 45;
    if (exponentNegative || wchar(text, index) === 43) index++;
    const first = index;
    for (;;) {
      const digit = aokanaCrtWideDigit(wchar(text, index));
      if (digit < 0 || digit > 9) break;
      exponent = Math.min(5201, exponent * 10 + digit);
      index++;
    }
    if (index === first) {
      index = exponentStart;
      exponent = 0;
    } else if (exponentNegative) exponent = -exponent;
  }
  while (digits.at(-1) === 0) digits.pop();
  if (digits.length === 0) return floating(sign, index);
  if (exponent > 5200) return floating(sign | 0x7ff0000000000000n, index, true);
  if (exponent < -5200) return floating(sign, index, true);
  exponent = (exponent + Math.imul(integerDigits, hexadecimal ? 4 : 1)) | 0;
  if (exponent > 5200) return floating(sign | 0x7ff0000000000000n, index, true);
  if (exponent < -5200) return floating(sign, index, true);
  let mantissa = 0n;
  for (const digit of digits) mantissa = mantissa * BigInt(base) + BigInt(digit);
  const power = exponent - digits.length * (hexadecimal ? 4 : 1);
  const factor = BigInt(hexadecimal ? 2 : 10) ** BigInt(Math.abs(power));
  const rounded = rationalBits(power >= 0 ? mantissa * factor : mantissa, power >= 0 ? 1n : factor);
  return floating(sign | rounded.bits, index, rounded.rangeError);
}

/** 1400ade50 converts accepted binary64 values to Q16 with near-integer snapping, floor and CVTTSD2SI. */
export function parseAokanaPropertyNumber(
  kind: 0 | 1 | 2 | 3,
  input: string,
): {result: number; value?: number} {
  if (kind !== 3) {
    const parsed = parseAokanaCrtWideInteger(input, kind === 2 ? 16 : 10, kind === 0);
    return parsed.end === 0 ? {result: 0x80000008} : {result: 0, value: parsed.value | 0};
  }
  const parsed = parseAokanaCrtWideFloat(input);
  if (parsed.end === 0) return {result: 0x80000008};
  let value = parsed.value * 65536;
  const floor = Math.floor(value);
  if (1 - 2 ** -14 <= value - floor) value = Math.ceil(value);
  else if (value - floor <= 2 ** -14) value = floor;
  value = Math.floor(value);
  return {
    result: 0,
    value:
      Number.isFinite(value) && value >= -2147483648 && value <= 2147483647
        ? value | 0
        : -2147483648,
  };
}
