/** Code page 932 lead bytes as reported by IsDBCSLeadByteEx(CP_ACP) on Japanese Windows. */
export function isCp932LeadByte(byte: number): boolean {
  return (byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xfc);
}

const decoder = new TextDecoder('shift-jis');
export function decodeCp932(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

let encoding: Map<string, number> | null = null;
/** Characters to their code page 932 codes, from the decoder; the first code wins. */
function cp932Codes(): Map<string, number> {
  if (encoding) return encoding;
  const codes = new Map<string, number>();
  const add = (code: number, bytes: Uint8Array): void => {
    const text = decoder.decode(bytes);
    if (text.length === 1 && text !== '�' && !codes.has(text)) codes.set(text, code);
  };
  for (let byte = 0; byte < 0x100; byte++)
    if (!isCp932LeadByte(byte)) add(byte, Uint8Array.of(byte));
  for (let lead = 0x81; lead <= 0xfc; lead++) {
    if (!isCp932LeadByte(lead)) continue;
    for (let trail = 0x40; trail <= 0xfc; trail++)
      if (trail !== 0x7f) add((lead << 8) | trail, Uint8Array.of(lead, trail));
  }
  return (encoding = codes);
}

/** WideCharToMultiByte(CP_ACP) for Japanese Windows; null when a character has no code. */
export function encodeCp932(text: string): Uint8Array | null {
  const codes = cp932Codes();
  const out: number[] = [];
  for (const character of text) {
    const code = codes.get(character);
    if (code === undefined) return null;
    if (code > 0xff) out.push(code >>> 8, code & 0xff);
    else out.push(code);
  }
  return Uint8Array.from(out);
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
