import type {BurikoBpPointer} from '../bp/memory.js';
import {burikoCompareNamedBytes} from './named-value-map.js';
import {BurikoNativeText, textByte, textBytes, textLength, writeText} from './text.js';

const pointer = (bytes: Uint8Array): BurikoBpPointer => ({bytes, offset: 0});
const separator = pointer(Uint8Array.of(92, 0));
const newline = pointer(Uint8Array.of(10, 0));

/** Native 64-byte entry owned by the sentinel at 1d2760 or by one layout invocation. */
export interface BurikoRubyAnnotation {
  readonly key: Uint8Array;
  readonly keyByteLength: number;
  readonly keyWideLength: number;
  readingWide: string;
  reading: Uint8Array;
  codes: Uint32Array;
  readingLength: number;
  readonly oneUse: number;
  used: number;
  next: BurikoRubyAnnotation | null;
}

function wideUnit(value: string, index: number): number {
  if (index === value.length) return 0;
  if (index < 0 || index > value.length)
    throw new RangeError('Buriko ruby code conversion reads outside its wide text');
  return value.charCodeAt(index);
}

/** 077f80 counts UTF-16 units; when an output is supplied, f8a50 advances by each decoded code. */
export function burikoTextCodes(
  text: BurikoNativeText,
  source: BurikoBpPointer,
  output: Uint32Array | null = null,
): number {
  const wide = text.decodeAuto(source),
    count = wide.length >>> 0;
  if (output !== null) {
    if (output.length < count)
      throw new RangeError('Buriko ruby code output is smaller than its native count');
    let offset = 0;
    for (let index = 0; index < count; index++) {
      const first = wideUnit(wide, offset++);
      let code = first;
      if ((first - 0xd800) >>> 0 < 0x400) {
        const second = wideUnit(wide, offset);
        if ((second - 0xdc00) >>> 0 < 0x400) {
          code = (Math.imul(first, 0x400) + 0xfca10000) | (second - 0xdc00);
          offset++;
        }
      }
      output[index] = code >>> 0;
    }
  }
  return count;
}

/** 078020/0785a0 own annotation data separately from the 128-byte glyph-layout nodes. */
export class BurikoRubyAnnotations {
  private head: BurikoRubyAnnotation | null = null;
  constructor(readonly text: BurikoNativeText) {}

  get first(): BurikoRubyAnnotation | null {
    return this.head;
  }

  private reading(
    readingWide: string,
    reading: Uint8Array,
  ): {
    readingWide: string;
    reading: Uint8Array;
    codes: Uint32Array;
    readingLength: number;
  } {
    const readingLength = burikoTextCodes(this.text, pointer(reading)),
      codes = new Uint32Array(readingLength);
    burikoTextCodes(this.text, pointer(reading), codes);
    return {readingWide, reading, codes, readingLength};
  }

  /** 0785a0 updates the first matching entry only for a persistent insertion. */
  add(key: BurikoBpPointer, reading: BurikoBpPointer, oneUse = 0): void {
    const normalized = this.text.convertEncoding(key, 1),
      readingWide = this.text.decodeAuto(reading),
      encodedReading = this.text.encodeWide(readingWide, 1);
    oneUse |= 0;
    if (oneUse === 0) {
      for (let entry = this.head; entry !== null; entry = entry.next)
        if (burikoCompareNamedBytes(pointer(normalized), pointer(entry.key)) === 0) {
          Object.assign(entry, this.reading(readingWide, encodedReading));
          return;
        }
    }
    const keyByteLength = (textLength(pointer(normalized)) + 1) | 0;
    let previous: BurikoRubyAnnotation | null = null,
      next = this.head;
    while (next !== null) {
      if (oneUse === 0 ? next.keyByteLength <= keyByteLength : next.oneUse === 0) break;
      previous = next;
      next = next.next;
    }
    const entry: BurikoRubyAnnotation = {
      key: normalized.slice(),
      keyByteLength,
      keyWideLength: burikoTextCodes(this.text, pointer(normalized)),
      ...this.reading(readingWide, encodedReading),
      oneUse,
      used: 0,
      next,
    };
    if (previous === null) this.head = entry;
    else previous.next = entry;
  }

  /** 078530 encodes both supplied wide strings and inserts a one-use annotation. */
  addInlineWide(key: string, reading: string): void {
    const encodedKey = this.text.encodeWide(key, 1),
      encodedReading = this.text.encodeWide(reading, 1);
    this.add(pointer(encodedKey), pointer(encodedReading), 1);
  }

  /** 0781f0 copies the first unused prefix key and consumes only a one-use entry. */
  matchPrefix(
    source: BurikoBpPointer,
    includeWide = false,
  ): {key: Uint8Array; wide: string | null} | null {
    const mode = this.text.detectEncoding(source.bytes, source.offset);
    for (let entry = this.head; entry !== null; entry = entry.next) {
      const found = this.text.find(source, pointer(entry.key), mode);
      if (found !== 0 || entry.used !== 0) continue;
      const key = entry.key.slice(),
        wide = includeWide ? this.text.decodeAuto(pointer(entry.key)) : null;
      if (entry.oneUse !== 0) entry.used = (entry.used + 1) >>> 0;
      return {key, wide};
    }
    return null;
  }

  /** 078190 converts the current source before asking the shared prefix matcher. */
  matchEncodedPrefix(source: BurikoBpPointer): Uint8Array | null {
    return this.matchPrefix(pointer(this.text.convertEncoding(source, 1)))?.key ?? null;
  }

  /** 0782a0 performs conversion but compares the original argument, then borrows the buffers. */
  query(key: BurikoBpPointer): BurikoRubyAnnotation | null {
    this.text.convertEncoding(key, 1);
    for (let entry = this.head; entry !== null; entry = entry.next)
      if (burikoCompareNamedBytes(key, pointer(entry.key)) === 0) return {...entry, next: null};
    return null;
  }

  /** 078410 removes the first matching normalized key allowed by the inline-only flag. */
  remove(key: BurikoBpPointer, inlineOnly = 0): 0 | 1 {
    const normalized = pointer(this.text.convertEncoding(key, 1));
    let previous: BurikoRubyAnnotation | null = null,
      entry = this.head;
    while (entry !== null) {
      if (
        ((inlineOnly | 0) === 0 || entry.oneUse !== 0) &&
        burikoCompareNamedBytes(normalized, pointer(entry.key)) === 0
      ) {
        if (previous === null) this.head = entry.next;
        else previous.next = entry.next;
        return 1;
      }
      previous = entry;
      entry = entry.next;
    }
    return 0;
  }

  /** 078350 removes from the head through the same normalized-key path. */
  clear(): void {
    while (this.head !== null) this.remove(pointer(this.head.key));
  }

  /** 0783c0 removes through the unrestricted key path and restarts at the head each time. */
  clearInline(): void {
    let entry = this.head;
    while (entry !== null) {
      if (entry.oneUse === 0) entry = entry.next;
      else {
        this.remove(pointer(entry.key));
        entry = this.head;
      }
    }
  }

  /** 078020 parses native key\\reading lines, detecting the source encoding once. */
  import(source: BurikoBpPointer | null): 0 | 1 {
    if (source === null) return 0;
    const mode = this.text.detectEncoding(source.bytes, source.offset);
    let offset = source.offset;
    while (textByte(source.bytes, offset) !== 0) {
      const before = offset,
        keyLength = this.text.find({bytes: source.bytes, offset}, separator, mode);
      if (keyLength !== null && keyLength > 0) {
        if (keyLength >= 256)
          throw new RangeError('Buriko ruby key exceeds its native scratch range');
        const key = new Uint8Array(keyLength + 1);
        key.set(source.bytes.subarray(offset, offset + keyLength));
        offset += keyLength + 1;
        const lineEnd = this.text.find({bytes: source.bytes, offset}, newline, mode),
          readingLength = lineEnd ?? textLength({bytes: source.bytes, offset});
        if (readingLength > 0) {
          if (readingLength >= 256)
            throw new RangeError('Buriko ruby reading exceeds its native scratch range');
          const reading = new Uint8Array(readingLength + 1);
          reading.set(source.bytes.subarray(offset, offset + readingLength));
          offset += readingLength + Number(lineEnd !== null);
          this.add(pointer(key), pointer(reading));
        }
      }
      if (offset === before)
        throw new Error('Buriko ruby import does not advance its native input');
    }
    return 1;
  }

  /** 078e40 extracts matching persistent readings in source order, including repeated words. */
  extract(output: BurikoBpPointer | null, source: BurikoBpPointer): number {
    const normalized = this.text.convertEncoding(source, 1);
    let offset = 0,
      destination = output?.offset ?? 0,
      skip = 0,
      count = 0;
    while (textByte(normalized, offset) !== 0) {
      const character = this.text.readCharacter(normalized, offset, 1);
      if (skip < 1) {
        const matched = this.matchPrefix({bytes: normalized, offset});
        if (matched !== null) {
          count = (count + 1) | 0;
          const annotation = this.query(pointer(matched.key));
          if (annotation === null)
            throw new Error('Buriko matched ruby key is absent from its registry');
          const key = textBytes(pointer(annotation.key)),
            reading = textBytes(pointer(annotation.reading)),
            line = new Uint8Array(key.length + reading.length + 3);
          line.set(key);
          line[key.length] = 92;
          line.set(reading, key.length + 1);
          line[line.length - 2] = 10;
          if (output === null) throw new Error('Buriko annotation collection writes through null');
          writeText({bytes: output.bytes, offset: destination}, line);
          destination += line.length - 1;
          skip = (burikoTextCodes(this.text, pointer(matched.key)) - 1) | 0;
        }
      } else skip = (skip - 1) | 0;
      offset += character.length;
    }
    return count;
  }
}
