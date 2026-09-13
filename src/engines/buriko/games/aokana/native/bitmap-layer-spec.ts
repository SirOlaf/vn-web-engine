import {AokanaNativeText} from './text.js';
import {terminatedNativeBytes} from './program-files.js';

export interface AokanaBitmapLayer {
  needsLoad: boolean;
  readonly name: Uint8Array;
  readonly positioned: boolean;
  readonly x: number;
  readonly y: number;
  readonly mode: number;
  readonly opacity: number;
}

/** 09B6A0 splits at the first character delimiter using the title's detected encoding. */
function split(text: AokanaNativeText, bytes: Uint8Array, offset: number, first: number, second = 0): number | null {
  const pointer = {bytes, offset};
  const a = text.findCharacter(pointer, first), b = second === 0 ? null : text.findCharacter(pointer, second);
  const found = a === null ? b : b === null ? a : Math.min(a, b);
  if (found === null) return null;
  bytes[found] = 0;
  return found + 1;
}

/** 09B540 compares entire tokens to '-' and '0x', then accumulates wrapping DWORD digits. */
function number(text: AokanaNativeText, bytes: Uint8Array, cursor: {offset: number | null}): number | null {
  if (cursor.offset === null) return null;
  const start = cursor.offset;
  cursor.offset = split(text, bytes, start, 44, 62);
  const end = bytes.indexOf(0, start), token = bytes.slice(start, end + 1);
  text.lowercase({bytes: token, offset: 0});
  let at = 0;
  while (token[at] === 32) at++;
  const negative = token[at] === 45 && token[at + 1] === 0;
  if (negative) at++;
  const hexadecimal = token[at] === 48 && token[at + 1] === 120 && token[at + 2] === 0;
  if (hexadecimal) at += 2;
  let value = 0, found = false;
  for (;;) {
    const digit = token[at++]!;
    if (digit >= 48 && digit <= 57) value = (Math.imul(value, hexadecimal ? 16 : 10) + digit - 48) | 0;
    else if (hexadecimal && digit >= 97 && digit <= 102) value = (Math.imul(value, 16) + digit - 97) | 0;
    else break;
    found = true;
  }
  return found ? negative ? -value | 0 : value : null;
}

/** 09BCB0 keeps filename spelling, trims only ASCII spaces, and retains list order. */
export function parseAokanaBitmapLayers(text: AokanaNativeText, name: Uint8Array):
  {result: 0; layers: AokanaBitmapLayer[]} | {result: 0x80000001; part: number} {
  const bytes = terminatedNativeBytes(name).slice(), layers: AokanaBitmapLayer[] = [];
  let start: number | null = 0;
  while (start !== null) {
    const next = split(text, bytes, start, 47);
    const cursor = {offset: split(text, bytes, start, 44, 62)};
    if (bytes[start] === 0) return {result: 0x80000001, part: layers.length + 1};
    while (bytes[start] === 32) start++;
    let end = bytes.indexOf(0, start);
    while (end > start && bytes[end - 1] === 32) end--;
    bytes[end] = 0;
    const filename = bytes.slice(start, end + 1);
    const x = number(text, bytes, cursor), y = number(text, bytes, cursor);
    const mode = number(text, bytes, cursor), opacity = number(text, bytes, cursor);
    layers.push({needsLoad: true, name: filename, positioned: x !== null && y !== null,
      x: x ?? 0, y: y ?? 0, mode: mode === null ? 0 : mode >>> 0 <= 7 ? mode + 32 : 128,
      opacity: opacity !== null && opacity >>> 0 <= 256 ? opacity : 0});
    start = next;
  }
  return {result: 0, layers};
}

/** B9330's Japanese decimal formatter used by the missing-part diagnostic. */
export function aokanaJapaneseNumber(value: number): string {
  value >>>= 0;
  if (value === 0) return '零';
  const digits = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const small = ['', '十', '百', '千'], large = ['', '万', '億'];
  let result = '', position = 0;
  while (value !== 0) {
    const digit = value % 10, local = position & 3;
    const suffix = local === 0 ? large[position >>> 2]! : digit === 0 ? '' : small[local]!;
    const prefix = digit === 1 && local !== 0 ? '' : digits[digit]!;
    result = prefix + suffix + result;
    value = Math.floor(value / 10); position++;
  }
  return result;
}
