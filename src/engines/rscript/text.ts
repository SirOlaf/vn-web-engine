/** Code page 932 lead bytes as reported by IsDBCSLeadByteEx(CP_ACP) on Japanese Windows. */
export function isCp932LeadByte(byte: number): boolean {
  return (byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xfc);
}

const decoder = new TextDecoder('shift-jis');
export function decodeCp932(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Parses an `@@-12` reference like 0x4593C0: '@' count in the high word, signed value low. */
export function parseVariableReference(bytes: Uint8Array): {levels: number; value: number} {
  let cursor = 0,
    levels = 0,
    negative = false,
    value = 0;
  while (bytes[cursor] === 0x40) {
    levels++;
    cursor++;
  }
  if (bytes[cursor] === 0x2d) {
    negative = true;
    cursor++;
  }
  while (cursor < bytes.length && bytes[cursor]! >= 0x30 && bytes[cursor]! <= 0x39)
    value = value * 10 + bytes[cursor++]! - 0x30;
  if (negative) value = -value;
  return {levels, value: (value << 16) >> 16};
}

/** ASCII decimal as a Shift-JIS byte string. */
export function asciiDecimal(value: number): Uint8Array {
  return new TextEncoder().encode(String(value));
}

/** sub_459420: signed decimal rendered with full-width Shift-JIS digits and minus sign. */
export function fullWidthDecimal(value: number): Uint8Array {
  const digits = String(value | 0);
  const out = new Uint8Array(digits.length * 2);
  for (let i = 0; i < digits.length; i++) {
    const c = digits.charCodeAt(i);
    out[i * 2] = c === 0x2d ? 0x81 : 0x82;
    out[i * 2 + 1] = c === 0x2d ? 0x7c : c + 31;
  }
  return out;
}

/**
 * Script string expansion (0x424BE0): `@`-references first become decimal variable
 * values (0x424AD0), then `$0`..`$9` insert string registers (0x424A00). Both passes
 * skip the trail byte of double-byte characters.
 */
export function expandScriptText(
  source: Uint8Array,
  variable: (levels: number, value: number) => number,
  stringRegister: (index: number) => Uint8Array,
): Uint8Array {
  const first: number[] = [];
  for (let i = 0; i < source.length && source[i] !== 0;) {
    const byte = source[i]!;
    if (isCp932LeadByte(byte) && i + 1 < source.length) {
      first.push(byte, source[i + 1]!);
      i += 2;
    } else if (byte === 0x40) {
      const start = i;
      while (
        i < source.length &&
        (source[i] === 0x40 || source[i] === 0x2d || (source[i]! >= 0x30 && source[i]! <= 0x39))
      )
        i++;
      const {levels, value} = parseVariableReference(source.subarray(start, i));
      first.push(...asciiDecimal(variable(levels, value)));
    } else {
      first.push(byte);
      i++;
    }
  }
  const result: number[] = [];
  for (let i = 0; i < first.length;) {
    const byte = first[i]!;
    if (isCp932LeadByte(byte) && i + 1 < first.length) {
      result.push(byte, first[i + 1]!);
      i += 2;
    } else if (byte === 0x24) {
      const next = first[i + 1];
      if (next !== undefined && next >= 0x30 && next <= 0x39) {
        result.push(...stringRegister(next - 0x30));
        i += 2;
      } else {
        result.push(0x24);
        i++;
      }
    } else {
      result.push(byte);
      i++;
    }
  }
  return Uint8Array.from(result);
}
