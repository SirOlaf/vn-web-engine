import type {AokanaBpPointer} from '../bp/memory.js';
import {CP932_TO_UNICODE, UNICODE_TO_CP932} from './text-cp932-data.js';

export type AokanaTextMode = 0 | 1 | 0x80000000;
export interface AokanaTextCharacter {
  value: number;
  length: number;
  fullWidth: number;
}

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
const cp932Decode = mapping(CP932_TO_UNICODE, 0x30fb);
const cp932Encode = mapping(UNICODE_TO_CP932, 0x3f);
const utf8Decoder = new TextDecoder('utf-8', {ignoreBOM: true});
const utf8Encoder = new TextEncoder();

export function textByte(bytes: Uint8Array, offset: number): number {
  const value = bytes[offset];
  if (value === undefined) throw new RangeError('Aokana native text read outside backing storage');
  return value;
}

export function textLength(pointer: AokanaBpPointer): number {
  let length = 0;
  while (textByte(pointer.bytes, pointer.offset + length) !== 0) length++;
  return length >>> 0;
}

export function textBytes(pointer: AokanaBpPointer, includeTerminator = false): Uint8Array {
  return pointer.bytes.subarray(
    pointer.offset,
    pointer.offset + textLength(pointer) + Number(includeTerminator),
  );
}

/** Native strcpy copies forward one byte at a time, including on overlapping addresses. */
export function copyText(destination: AokanaBpPointer, source: AokanaBpPointer): void {
  let index = 0;
  for (;;) {
    const value = textByte(source.bytes, source.offset + index);
    if (destination.offset + index >= destination.bytes.length)
      throw new RangeError('Aokana native text write outside backing storage');
    destination.bytes[destination.offset + index] = value;
    index++;
    if (value === 0) return;
  }
}

export function writeText(destination: AokanaBpPointer, bytes: Uint8Array): void {
  if (destination.offset < 0 || destination.offset + bytes.length > destination.bytes.length)
    throw new RangeError('Aokana native text write outside backing storage');
  destination.bytes.set(bytes, destination.offset);
}

/** 1400f8580 accepts 81..9f, e0..fc, and ff as a lead byte; it does not inspect the trail. */
export function isNativeCp932Lead(byte: number): boolean {
  return ((byte + 0x60) & 255) > 0x3f && byte > 0x80 && ((byte + 3) & 255) > 1;
}

/** 1400f7820 checks only lead-bit count and continuation shape; 5..8-byte forms are accepted. */
export function classifyUtf8(bytes: Uint8Array, offset = 0): {result: number; length?: number} {
  const first = textByte(bytes, offset);
  if (first < 0x80) return {result: 0x80000000};
  if (first <= 0xc1) return {result: 0};
  let length = 1;
  if (first & 0x40)
    do {
      length++;
    } while (first & (0x80 >>> (length & 31)));
  for (let index = 1; index < length; index++) {
    if ((textByte(bytes, offset + index) & 0xc0) !== 0x80) return {result: 0};
  }
  return {result: 1, length};
}

/** 1400f7210 is a permissive legacy UTF-8 decoder with 32-bit shifts, not a Unicode validator. */
export function readNativeUtf8(bytes: Uint8Array, offset = 0): {value: number; length: number} {
  let value = textByte(bytes, offset);
  let length = 1;
  if (value >= 0x80) {
    let payload = 0;
    let previous: number;
    do {
      previous = length++;
      payload = (textByte(bytes, offset + previous) & 0x3f) | (payload << 6);
    } while (value & (0x80 >>> (length & 31)));
    value = payload | (((0xff >>> ((length + 1) & 31)) & value) << ((previous * 6) & 31));
  }
  return {value: value >>> 0, length};
}

export function writeNativeUtf8(value: number): Uint8Array {
  value >>>= 0;
  if (value < 0x80) return Uint8Array.of(value);
  const length =
    value < 0x800
      ? 2
      : value < 0x10000
        ? 3
        : value < 0x200000
          ? 4
          : value < 0x4000000
            ? 5
            : value <= 0x7fffffff
              ? 6
              : 0;
  if (length === 0) return new Uint8Array();
  const bytes = new Uint8Array(length);
  bytes[0] = (value >>> (length * 6 - 6)) | (-2 << (7 - length));
  for (let index = 1; index < length; index++)
    bytes[index] = ((value >>> ((length - index) * 6 - 6)) & 0x3f) | 0x80;
  return bytes;
}

const punctuation = new Set([
  0x2c, 0x2e, 0xff64, 0xff61, 0x3a, 0x3b, 0x3f, 0x21, 0xff9e, 0xff9f, 0xff65, 0x3001, 0x3002,
  0xff0c, 0xff0e, 0xff1a, 0xff1b, 0xff1f, 0xff01, 0x309b, 0x309c, 0x2010, 0x5d, 0x7d, 0x29, 0xff09,
  0x3015, 0xff3d, 0xff5d, 0x3009, 0x300b, 0x300d, 0x300f, 0x3011, 0x2018, 0x201c,
]);

export function isNativePunctuation(value: number): boolean {
  return punctuation.has(value >>> 0);
}

/** Exact success condition of 1400f88c0's -1-length, two-wchar Win32 call. */
export function nativeCp932CharacterToWide(value: number): number {
  value >>>= 0;
  const special =
    (value | 0) < 0 ? ((value & 0x7fffffff) - 0xf001) >>> 0 < 0x7ff : (value - 0xff01) >>> 0 < 0xff;
  if (special) return (value & 255) | 0xf000;
  if ((value - 0xef40) >>> 0 < 0xc0) return value & 0xffff;
  // A successful count of one for cbMultiByte=-1 includes NUL, hence its sole output is NUL.
  // Any nonempty conversion either returns at least two or fails the two-wchar capacity check.
  return 0;
}

/** Mutable globals DAT_140274584 and DAT_1401ca4b4 belong to one Aokana runtime. */
export class AokanaNativeText {
  private selectedMode: 0 | 1 = 0;
  get mode(): 0 | 1 {
    return this.selectedMode;
  }
  get codePage(): 932 | 65001 {
    return this.selectedMode === 0 ? 932 : 65001;
  }

  selectMode(mode: number): boolean {
    if (mode !== 0 && mode !== 1) return false;
    this.selectedMode = mode;
    return true;
  }

  /** Six shaped multibyte sequences establish UTF-8 immediately; the remaining bytes are not scanned. */
  detectEncoding(bytes: Uint8Array, offset = 0, skipControl3 = false): AokanaTextMode {
    let sequences = 0;
    for (;;) {
      const first = textByte(bytes, offset);
      if (first === 0) return sequences === 0 ? 0x80000000 : 1;
      if (first < 0x80) {
        offset += skipControl3 && first === 3 ? 2 : 1;
        continue;
      }
      if (first <= 0xc1) return 0;
      const sequence = classifyUtf8(bytes, offset);
      if (sequence.result !== 1) return 0;
      if (++sequences >= 6) return 1;
      offset += sequence.length!;
    }
  }

  readCharacter(bytes: Uint8Array, offset = 0, mode: number = -1): AokanaTextCharacter {
    if ((mode | 0) === -1) mode = this.mode;
    if (mode === 0) {
      const first = textByte(bytes, offset);
      const fullWidth = Number(isNativeCp932Lead(first));
      return {
        value: fullWidth ? first * 256 + textByte(bytes, offset + 1) : first,
        length: fullWidth + 1,
        fullWidth,
      };
    }
    if (mode === 1) {
      let {value, length} = readNativeUtf8(bytes, offset);
      if ((value - 0xd800) >>> 0 < 0x400) {
        const next = readNativeUtf8(bytes, offset + length);
        if ((next.value - 0xdc00) >>> 0 < 0x400) {
          value = (((value - 0xd7c0) * 0x400) | (next.value - 0xdc00)) >>> 0;
          length += next.length;
        }
      }
      return {value, length, fullWidth: Number(!((value - 0x80) >>> 0 > 0xfee0 && value < 0xffa0))};
    }
    if (mode >>> 0 === 0x80000000) return {value: textByte(bytes, offset), length: 1, fullWidth: 0};
    return {value: 0, length: 0, fullWidth: 0};
  }

  decodeCp932(bytes: Uint8Array): string {
    let output = '';
    for (let offset = 0; offset < bytes.length; offset++) {
      const first = bytes[offset]!;
      const lead = (first >= 0x81 && first <= 0x9f) || (first >= 0xe0 && first <= 0xfc);
      if (lead && offset + 1 < bytes.length && bytes[offset + 1] !== 0) {
        output += String.fromCharCode(cp932Decode[(first << 8) | bytes[++offset]!]!);
      } else output += String.fromCharCode(cp932Decode[first]!);
    }
    return output;
  }

  decodeBytes(bytes: Uint8Array, mode: 0 | 1): string {
    return mode === 0 ? this.decodeCp932(bytes) : utf8Decoder.decode(bytes);
  }

  decodeAuto(pointer: AokanaBpPointer): string {
    const mode = this.detectEncoding(pointer.bytes, pointer.offset) === 0 ? 0 : 1;
    return this.decodeBytes(textBytes(pointer), mode);
  }

  /** 1400f81d0 mixes CP932 and shaped UTF-8 runs, with native estimated conversion capacities. */
  decodeMixed(pointer: AokanaBpPointer): string {
    const input = textBytes(pointer, true);
    const output: (number | undefined)[] = new Array(input.length);
    let outputOffset = 0;
    const convert = (mode: 0 | 1, start: number, size: number, capacity: number): number => {
      if (size === 0 || capacity < 0) return 0;
      if (start < 0 || size < 0 || start + size > input.length)
        throw new RangeError('Aokana mixed text conversion reads outside native input');
      const wide = this.decodeBytes(input.subarray(start, start + size), mode);
      // cchWideChar=0 is a length query even though the native output pointer is nonnull.
      if (capacity === 0) return wide.length;
      const written = Math.min(wide.length, capacity);
      if (outputOffset + written > output.length)
        throw new RangeError('Aokana mixed text conversion exceeds its native allocation');
      // Windows Vista+ writes the fitting UTF-16 prefix, including a lone high surrogate,
      // then returns zero for ERROR_INSUFFICIENT_BUFFER.
      for (let index = 0; index < written; index++)
        output[outputOffset + index] = wide.charCodeAt(index);
      return wide.length <= capacity ? wide.length : 0;
    };
    let mode = -1,
      offset = 0,
      runStart = 0,
      pendingStart = 0;
    let cpCount = 0,
      utfCount = 0,
      ambiguousAscii = 0;
    while (textByte(input, offset) !== 0) {
      const sequence = classifyUtf8(input, offset);
      if (sequence.result === 0) {
        if (mode === -1) {
          mode = 0;
          utfCount = 0;
          ambiguousAscii = 0;
        }
        let step: number;
        if (mode === 0 && utfCount === 1) {
          cpCount += 1 + ambiguousAscii;
          step = 1;
        } else {
          if (mode === 0 && utfCount !== 0) {
            outputOffset += convert(0, runStart, offset - pendingStart, cpCount);
            cpCount = 0;
            runStart = pendingStart;
          }
          if (mode === 1 || utfCount !== 0) {
            outputOffset += convert(1, runStart, offset - runStart, utfCount);
            runStart = offset;
          }
          step = this.readCharacter(input, offset, 0).length;
        }
        mode = 0;
        cpCount++;
        utfCount = 0;
        offset += step;
      } else if (sequence.result === 1) {
        const length = sequence.length!;
        if (mode === -1) {
          ambiguousAscii = 0;
          utfCount++;
          mode = 1;
          cpCount = 0;
        } else if (mode === 0) {
          if (length >= 4 || length === 2 || utfCount !== 0) {
            outputOffset += convert(0, runStart, pendingStart - runStart, cpCount);
            cpCount = 0;
            utfCount += ambiguousAscii + 1;
            mode = 1;
            runStart = pendingStart;
          } else {
            utfCount = 1;
            pendingStart = offset;
          }
        } else utfCount++;
        offset += length;
      } else {
        if (mode === 0) {
          if (utfCount === 0) cpCount++;
          else if (textByte(input, offset) > 0x3f) ambiguousAscii++;
          else utfCount++;
        } else {
          if (mode === -1) cpCount++;
          utfCount++;
        }
        offset++;
      }
    }
    convert(
      mode === 1 ? 1 : 0,
      runStart,
      offset - runStart + 1,
      (mode === 1 ? utfCount : cpCount) + 1,
    );
    let result = '';
    for (const unit of output) {
      if (unit === undefined)
        throw new Error('Aokana mixed text decoder reads unwritten native allocation');
      if (unit === 0) return result;
      result += String.fromCharCode(unit);
    }
    throw new RangeError(
      'Aokana mixed text decoder reads beyond its unterminated native allocation',
    );
  }

  encodeWide(value: string, mode: number = -1): Uint8Array {
    if (mode !== 0 && mode !== 1) mode = this.mode;
    const nul = value.indexOf('\0');
    if (nul >= 0) value = value.slice(0, nul);
    if (mode === 1) {
      const encoded = utf8Encoder.encode(value);
      const result = new Uint8Array(encoded.length + 1);
      result.set(encoded);
      return result;
    }
    const bytes: number[] = [];
    for (let index = 0; index < value.length; index++) {
      const encoded = cp932Encode[value.charCodeAt(index)]!;
      if (encoded > 255) bytes.push(encoded >>> 8);
      bytes.push(encoded & 255);
    }
    bytes.push(0);
    return Uint8Array.from(bytes);
  }

  convertEncoding(pointer: AokanaBpPointer, mode: number): Uint8Array {
    if (mode !== 0 && mode !== 1) mode = this.mode;
    const sourceMode = this.detectEncoding(pointer.bytes, pointer.offset);
    if (sourceMode === 0x80000000 || sourceMode === mode) return textBytes(pointer, true).slice();
    return this.encodeWide(this.decodeAuto(pointer), mode);
  }

  find(source: AokanaBpPointer, needle: AokanaBpPointer, mode: number = -1): number | null {
    if ((mode | 0) === -1) mode = this.detectEncoding(source.bytes, source.offset);
    if (mode >>> 0 === 0x80000000) {
      const input = textBytes(source),
        search = textBytes(needle);
      for (let offset = 0; offset <= input.length - search.length; offset++) {
        let index = 0;
        while (index < search.length && input[offset + index] === search[index]) index++;
        if (index === search.length) return offset;
      }
      return null;
    }
    if (mode !== 0 && mode !== 1) return null;
    const search: number[] = [];
    for (let offset = needle.offset; textByte(needle.bytes, offset) !== 0;) {
      const character = this.readCharacter(needle.bytes, offset, mode);
      search.push(character.value);
      offset += character.length;
    }
    if (search.length === 0 && textByte(source.bytes, source.offset) !== 0) {
      throw new RangeError('Aokana multibyte substring search reads an empty native allocation');
    }
    let matched = 0,
      start = 0;
    for (let offset = source.offset; textByte(source.bytes, offset) !== 0;) {
      const character = this.readCharacter(source.bytes, offset, mode);
      if (character.value === search[matched]) {
        if (matched === 0) start = offset;
        if (++matched === search.length) return start - source.offset;
      } else matched = 0; // Native does not retry the mismatching character as a new candidate.
      offset += character.length;
    }
    return null;
  }

  /** 1400f86e0 returns a native pointer offset, including the terminator when searching zero. */
  findCharacter(pointer: AokanaBpPointer, value: number, mode = -1): number | null {
    if ((mode | 0) === -1) mode = this.detectEncoding(pointer.bytes, pointer.offset);
    value >>>= 0;
    if (mode >>> 0 === 0x80000000) {
      for (let offset = pointer.offset; ; offset++) {
        const byte = textByte(pointer.bytes, offset);
        if (byte === (value & 255)) return offset;
        if (byte === 0) return null;
      }
    }
    if (mode !== 0 && mode !== 1) return null;
    let offset = pointer.offset;
    while (textByte(pointer.bytes, offset) !== 0) {
      const character = this.readCharacter(pointer.bytes, offset, mode);
      if (character.value === value) return offset;
      offset += character.length;
    }
    return value === 0 ? offset : null;
  }

  lowercase(pointer: AokanaBpPointer): void {
    const mode = this.detectEncoding(pointer.bytes, pointer.offset);
    for (let offset = pointer.offset; textByte(pointer.bytes, offset) !== 0;) {
      const character = this.readCharacter(pointer.bytes, offset, mode);
      if (character.length === 1 && character.value >= 65 && character.value <= 90)
        pointer.bytes[offset] = character.value + 32;
      offset += character.length;
    }
  }
}
