import {CP932_TO_UNICODE, UNICODE_TO_CP932} from './cp932-data.js';

/**
 * Windows code page 932, as MultiByteToWideChar and WideCharToMultiByte convert it on
 * Japanese Windows: undefined codes decode to U+30FB, and characters without a code encode
 * through the best-fit table or as `?`.
 */

function mapping(data: string, fallback: number): Uint16Array {
  const table = new Uint16Array(65536).fill(fallback);
  for (let offset = 0; offset < data.length; offset += 8) {
    table[Number.parseInt(data.slice(offset, offset + 4), 16)] = Number.parseInt(
      data.slice(offset + 4, offset + 8),
      16,
    );
  }
  return table;
}

let decodeTable: Uint16Array | null = null,
  encodeTable: Uint16Array | null = null;
function cp932Decode(): Uint16Array {
  return (decodeTable ??= mapping(CP932_TO_UNICODE, 0x30fb));
}
function cp932Encode(): Uint16Array {
  return (encodeTable ??= mapping(UNICODE_TO_CP932, 0x3f));
}

/** Lead bytes as IsDBCSLeadByteEx(932) reports them. */
export function isCp932LeadByte(byte: number): boolean {
  return (byte >= 0x81 && byte <= 0x9f) || (byte >= 0xe0 && byte <= 0xfc);
}

/**
 * The UTF-16 unit of one single-byte or double-byte code. A lead byte followed by a zero or
 * by the end of the input decodes on its own.
 */
export function decodeCp932Code(code: number): number {
  return cp932Decode()[code]!;
}

export function decodeCp932(bytes: Uint8Array): string {
  const table = cp932Decode();
  let output = '';
  for (let offset = 0; offset < bytes.length; offset++) {
    const first = bytes[offset]!;
    if (isCp932LeadByte(first) && offset + 1 < bytes.length && bytes[offset + 1] !== 0)
      output += String.fromCharCode(table[(first << 8) | bytes[++offset]!]!);
    else output += String.fromCharCode(table[first]!);
  }
  return output;
}

/** The single-byte or double-byte code of one UTF-16 unit, best fit included. */
export function encodeCp932Unit(unit: number): number {
  return cp932Encode()[unit]!;
}

/** WideCharToMultiByte(932) with best fit; characters without a code become `?`. */
export function encodeCp932(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const code = encodeCp932Unit(text.charCodeAt(index));
    if (code > 0xff) bytes.push(code >>> 8);
    bytes.push(code & 0xff);
  }
  return Uint8Array.from(bytes);
}

/**
 * The bytes of `text` when every character has its own code, as WideCharToMultiByte with
 * WC_NO_BEST_FIT_CHARS reports through its used-default flag; otherwise null.
 */
export function encodeCp932Exact(text: string): Uint8Array | null {
  const bytes = encodeCp932(text);
  return decodeCp932(bytes) === text ? bytes : null;
}
