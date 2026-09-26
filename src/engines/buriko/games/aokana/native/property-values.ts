import type {AokanaBpPointer} from '../bp/memory.js';
import type {AokanaNativeText} from './text.js';

/** A borrowed native DWORD represented by its actual TypeScript owner field. */
export interface AokanaPropertyWordBinding {
  readPropertyWord(): number;
}
export type AokanaPropertySource = AokanaBpPointer | AokanaPropertyWordBinding;

export function propertyTextPointer(source: AokanaPropertySource | null): AokanaBpPointer {
  if (source === null || 'readPropertyWord' in source)
    throw new Error('Aokana property text requires native byte storage');
  return source;
}

export function readPropertyWord(pointer: AokanaPropertySource | null): number {
  if (pointer === null) throw new Error('Aokana property editor dereferences a null value');
  if ('readPropertyWord' in pointer) return pointer.readPropertyWord() | 0;
  if (pointer.offset < 0 || pointer.offset + 4 > pointer.bytes.length)
    throw new RangeError('Aokana property DWORD read exceeds native storage');
  return new DataView(
    pointer.bytes.buffer,
    pointer.bytes.byteOffset,
    pointer.bytes.byteLength,
  ).getInt32(pointer.offset, true);
}

export function writePropertyWord(pointer: AokanaPropertySource | null, value: number): void {
  if (pointer === null) throw new Error('Aokana property editor dereferences a null output');
  if ('readPropertyWord' in pointer)
    throw new Error('Aokana borrowed object property requires its native edit callback');
  if (pointer.offset < 0 || pointer.offset + 4 > pointer.bytes.length)
    throw new RangeError('Aokana property DWORD write exceeds native storage');
  new DataView(pointer.bytes.buffer, pointer.bytes.byteOffset, pointer.bytes.byteLength).setInt32(
    pointer.offset,
    value,
    true,
  );
}

/** 1400b0550 rounds the integer to binary32 before multiplying by the exact power 2^-16. */
export function formatPropertyScalar(kind: number, value: number): string {
  value |= 0;
  switch (kind | 0) {
    case 0:
      return String(value);
    case 1:
      return String(value >>> 0);
    case 2:
      return '0x' + (value >>> 0).toString(16).toUpperCase().padStart(8, '0');
    case 3: {
      const roundedInteger = Math.fround(value);
      // The CRT's options=0 decimal conversion rounds halfway away from zero.
      const scaled = (BigInt(Math.abs(roundedInteger)) * 1000000n + 32768n) / 65536n;
      const digits = scaled.toString().padStart(7, '0');
      return (roundedInteger < 0 ? '-' : '') + digits.slice(0, -6) + '.' + digits.slice(-6);
    }
    case 4:
      return value === 0 ? 'FALSE' : 'TRUE';
    default:
      throw new RangeError('Aokana scalar property formatter requires native type 0..4');
  }
}

/** 1400b0550 formats before the caller reads the row name or constructs its live-source record. */
export function formatPropertySource(
  kind: number,
  source: AokanaPropertySource | null,
  text: AokanaNativeText,
): {result: number; value?: string} {
  kind |= 0;
  if (kind >= 0 && kind <= 4)
    return {result: 0, value: formatPropertyScalar(kind, readPropertyWord(source))};
  if (kind === 5) {
    if (source === null) throw new Error('Aokana property text decoder dereferences a null source');
    return {result: 0, value: text.decodeAuto(propertyTextPointer(source))};
  }
  return {result: 0x8000000d};
}

/** 1400adc40's WM_CHAR result; null suppresses the message, otherwise the WCHAR is forwarded. */
export function propertyEditCharacter(
  kind: number,
  character: number,
  current: string,
  start: number,
): number | null {
  kind |= 0;
  start &= 0xffff;
  character >>>= 0;
  if (character === 8 && (kind !== 2 || start > 2)) return character;
  if (character === 0x1a) return character;
  const digit = character >= 0x30 && character <= 0x39;
  if (kind === 0 || kind === 3) {
    if (character === 0x2d) {
      const first = current.charCodeAt(0) || 0;
      return start === 0 && (first === 0 || (first >= 0x30 && first <= 0x39)) ? character : null;
    }
    if (digit) return character;
    if (kind === 3 && character === 0x2e && !current.includes('.'))
      return start >= (current.startsWith('-') ? 2 : 1) ? character : null;
    return null;
  }
  if (kind === 1) return digit ? character : null;
  if (kind === 2) {
    if (start < 2) return null;
    if (character >= 0x61 && character <= 0x66) character -= 0x20;
    return digit || (character >= 0x41 && character <= 0x46) ? character : null;
  }
  return kind === 5 ? character : null;
}

/** Both WM_KEYDOWN and WM_KEYUP protect the two-character hexadecimal prefix. */
export function propertyEditDeleteAllowed(kind: number, start: number): boolean {
  return (kind | 0) !== 2 || (start & 0xffff) >= 2;
}
