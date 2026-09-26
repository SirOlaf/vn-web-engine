import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import {textByte, textBytes} from './text.js';

/** 09db30 hashes signed bytes with wrapping DWORD arithmetic. */
export function aokanaNamedValueHash(key: AokanaBpPointer): number {
  let hash = 0;
  for (let offset = key.offset; ; offset++) {
    const value = textByte(key.bytes, offset);
    if (value === 0) return hash;
    hash = (Math.imul(hash, 233) + ((value << 24) >> 24)) >>> 0;
  }
}

/** 0f8e40 compares unsigned bytes, independently of encoding and CRT locale. */
export function aokanaCompareNamedBytes(first: AokanaBpPointer, second: AokanaBpPointer): -1 | 0 | 1 {
  for (let offset = 0; ; offset++) {
    const a = textByte(first.bytes, first.offset + offset),
      b = textByte(second.bytes, second.offset + offset);
    if (a !== b) return a < b ? -1 : 1;
    if (a === 0) return 0;
  }
}

/** The returned native pointer stays owned by its entry. Invalid native accesses fail deterministically. */
class NamedValue implements AokanaBpPointer {
  readonly offset = 0;
  private available = true;
  private objectValue: object | null = null;
  constructor(private contents: Uint8Array | null) {}
  get bytes(): Uint8Array {
    if (!this.available) throw new Error('Aokana named value is no longer available');
    if (this.contents === null) throw new Error('Aokana native object pointer has no scalar byte encoding');
    return this.contents;
  }
  get reference(): object | null {
    if (!this.available) throw new Error('Aokana named value is no longer available');
    return this.objectValue;
  }
  setReference(value: object): void {
    this.objectValue = value;
    this.contents = null;
  }
  write(source: AokanaBpPointer, width: number): void {
    const input = pointerView(source, width);
    this.contents ??= new Uint8Array(width);
    this.contents.set(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
    this.objectValue = null;
  }
  release(): void {
    this.available = false;
    this.objectValue = null;
    this.contents = null;
  }
}
interface NamedEntry {
  readonly hash: number;
  readonly key: AokanaBpPointer;
  value: NamedValue;
  next: NamedEntry | null;
}

/** 09def0/09dd70: the actual shared map class, separate from each consumer's registry. */
export class AokanaNamedValueMap {
  private first: NamedEntry | null = null;
  readonly valueWidth: number;
  constructor(valueWidth: number) {
    this.valueWidth = valueWidth >>> 0;
  }

  private find(key: AokanaBpPointer): NamedEntry | null {
    const hash = aokanaNamedValueHash(key);
    for (let entry = this.first; entry !== null; entry = entry.next)
      if (entry.hash === hash && aokanaCompareNamedBytes(key, entry.key) === 0) return entry;
    return null;
  }

  private insertEntry(key: AokanaBpPointer): NamedEntry {
    const hash = aokanaNamedValueHash(key);
    let previous: NamedEntry | null = null,
      entry = this.first;
    while (entry !== null) {
      if (entry.hash === hash && aokanaCompareNamedBytes(key, entry.key) === 0) break;
      previous = entry;
      entry = entry.next;
    }
    if (entry === null) {
      entry = {
        hash,
        key: {bytes: textBytes(key, true).slice(), offset: 0},
        value: new NamedValue(this.valueWidth === 0 ? null : new Uint8Array(this.valueWidth)),
        next: null,
      };
      if (previous === null) this.first = entry;
      else previous.next = entry;
    }
    return entry;
  }

  /** 09dd70 retains insertion order and fixed-width value identity when replacing a key. */
  insert(key: AokanaBpPointer, source: AokanaBpPointer): void {
    const entry = this.insertEntry(key);
    let width = this.valueWidth;
    if (this.valueWidth === 0) {
      entry.value.release();
      width = textBytes(source, true).length;
      entry.value = new NamedValue(new Uint8Array(width));
    }
    entry.value.write(source, width);
  }

  /** FD0F0's width-eight map stores an actual object pointer, never a fabricated VM address. */
  insertReference(key: AokanaBpPointer, reference: object): void {
    if (this.valueWidth !== 8) throw new Error('Aokana named object references require eight-byte values');
    this.insertEntry(key).value.setReference(reference);
  }

  findReference(key: AokanaBpPointer): object | null {
    return this.find(key)?.value.reference ?? null;
  }

  /** FCEF0 dereferences the value-storage pointers enumerated by09db60. */
  referenceFromValuePointer(value: AokanaBpPointer): object | null {
    if (!(value instanceof NamedValue)) throw new Error('Aokana named reference is not value storage');
    return value.reference;
  }

  /** 09dba0 exposes owned bytes, including the terminator in width-zero maps. */
  findValue(key: AokanaBpPointer): AokanaBpPointer | null {
    return this.find(key)?.value ?? null;
  }

  private copy(entry: NamedEntry, output: AokanaBpPointer | null): void {
    if (output === null) return;
    const bytes = entry.value.bytes,
      destination = pointerView(output, bytes.length);
    new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength).set(bytes);
  }

  /** 09dc50: a null output queries existence without copying. */
  readByName(output: AokanaBpPointer | null, key: AokanaBpPointer): 0 | 0x80000001 {
    const entry = this.find(key);
    if (entry === null) return 0x80000001;
    this.copy(entry, output);
    return 0;
  }

  /** 09dbf0: signed insertion-order index; its missing status differs from named lookup. */
  readByIndex(output: AokanaBpPointer | null, index: number): 0 | 0x80000002 {
    index |= 0;
    let current = 0;
    for (let entry = this.first; entry !== null; entry = entry.next) {
      if (current === index) {
        this.copy(entry, output);
        return 0;
      }
      current = (current + 1) | 0;
    }
    return 0x80000002;
  }

  /** 09dce0 unlinks the first equal key before releasing its storage. */
  remove(key: AokanaBpPointer): 0 | 0x80000001 {
    const hash = aokanaNamedValueHash(key);
    let previous: NamedEntry | null = null;
    for (let entry = this.first; entry !== null; entry = entry.next) {
      if (entry.hash === hash && aokanaCompareNamedBytes(key, entry.key) === 0) {
        if (previous === null) this.first = entry.next;
        else previous.next = entry.next;
        entry.value.release();
        return 0;
      }
      previous = entry;
    }
    return 0x80000001;
  }

  /** 09deb0 repeatedly removes the live head. */
  clear(): void {
    while (this.first !== null) this.remove(this.first.key);
  }

  /** Used by 09db60 over the imported-language owner, whose global registry remains separate. */
  *valuePointers(): IterableIterator<AokanaBpPointer> {
    for (let entry = this.first; entry !== null; entry = entry.next) yield entry.value;
  }
}
