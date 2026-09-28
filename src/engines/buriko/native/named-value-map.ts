import {pointerView, type BurikoBpPointer} from '../bp/memory.js';
import {determinateTextEnd, textByte, textBytes} from './text.js';

/** 09db30 hashes signed bytes with wrapping DWORD arithmetic. */
export function burikoNamedValueHash(key: BurikoBpPointer): number {
  let hash = 0;
  const bytes = key.bytes,
    end = determinateTextEnd(bytes, key.offset);
  if (end >= 0) {
    for (let offset = key.offset; offset < end; offset++)
      hash = (Math.imul(hash, 233) + ((bytes[offset]! << 24) >> 24)) >>> 0;
    return hash;
  }
  for (let offset = key.offset; ; offset++) {
    const value = textByte(bytes, offset);
    if (value === 0) return hash;
    hash = (Math.imul(hash, 233) + ((value << 24) >> 24)) >>> 0;
  }
}

/** 0f8e40 compares unsigned bytes, independently of encoding and CRT locale. */
export function burikoCompareNamedBytes(
  first: BurikoBpPointer,
  second: BurikoBpPointer,
): -1 | 0 | 1 {
  const left = first.bytes,
    right = second.bytes;
  if (determinateTextEnd(left, first.offset) >= 0 && determinateTextEnd(right, second.offset) >= 0)
    for (let offset = 0; ; offset++) {
      const a = left[first.offset + offset]!,
        b = right[second.offset + offset]!;
      if (a !== b) return a < b ? -1 : 1;
      if (a === 0) return 0;
    }
  for (let offset = 0; ; offset++) {
    const a = textByte(left, first.offset + offset),
      b = textByte(right, second.offset + offset);
    if (a !== b) return a < b ? -1 : 1;
    if (a === 0) return 0;
  }
}

/** The returned native pointer stays owned by its entry. Invalid native accesses fail deterministically. */
class NamedValue implements BurikoBpPointer {
  readonly offset = 0;
  private available = true;
  private objectValue: object | null = null;
  constructor(private contents: Uint8Array | null) {}
  get bytes(): Uint8Array {
    if (!this.available) throw new Error('Buriko named value is no longer available');
    if (this.contents === null)
      throw new Error('Buriko native object pointer has no scalar byte encoding');
    return this.contents;
  }
  get reference(): object | null {
    if (!this.available) throw new Error('Buriko named value is no longer available');
    return this.objectValue;
  }
  setReference(value: object): void {
    this.objectValue = value;
    this.contents = null;
  }
  write(source: BurikoBpPointer, width: number): void {
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
  readonly key: BurikoBpPointer;
  value: NamedValue;
  next: NamedEntry | null;
}

/** 09def0/09dd70: the actual shared map class, separate from each consumer's registry. */
export class BurikoNamedValueMap {
  private first: NamedEntry | null = null;
  /** Entries by hash in list order. Lookups read the key exactly as the list walk does:
   * one full hash pass, then comparisons against equal-hash entries only. */
  private readonly buckets = new Map<number, NamedEntry[]>();
  private last: NamedEntry | null = null;
  readonly valueWidth: number;
  constructor(valueWidth: number) {
    this.valueWidth = valueWidth >>> 0;
  }

  private findHashed(key: BurikoBpPointer, hash: number): NamedEntry | null {
    const bucket = this.buckets.get(hash);
    if (bucket !== undefined)
      for (const entry of bucket) if (burikoCompareNamedBytes(key, entry.key) === 0) return entry;
    return null;
  }

  private find(key: BurikoBpPointer): NamedEntry | null {
    return this.findHashed(key, burikoNamedValueHash(key));
  }

  private insertEntry(key: BurikoBpPointer): NamedEntry {
    const hash = burikoNamedValueHash(key);
    let entry = this.findHashed(key, hash);
    if (entry === null) {
      entry = {
        hash,
        key: {bytes: textBytes(key, true).slice(), offset: 0},
        value: new NamedValue(this.valueWidth === 0 ? null : new Uint8Array(this.valueWidth)),
        next: null,
      };
      if (this.last === null) this.first = entry;
      else this.last.next = entry;
      this.last = entry;
      const bucket = this.buckets.get(hash);
      if (bucket === undefined) this.buckets.set(hash, [entry]);
      else bucket.push(entry);
    }
    return entry;
  }

  /** 09dd70 retains insertion order and fixed-width value identity when replacing a key. */
  insert(key: BurikoBpPointer, source: BurikoBpPointer): void {
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
  insertReference(key: BurikoBpPointer, reference: object): void {
    if (this.valueWidth !== 8)
      throw new Error('Buriko named object references require eight-byte values');
    this.insertEntry(key).value.setReference(reference);
  }

  findReference(key: BurikoBpPointer): object | null {
    return this.find(key)?.value.reference ?? null;
  }

  /** FCEF0 dereferences the value-storage pointers enumerated by09db60. */
  referenceFromValuePointer(value: BurikoBpPointer): object | null {
    if (!(value instanceof NamedValue))
      throw new Error('Buriko named reference is not value storage');
    return value.reference;
  }

  /** 09dba0 exposes owned bytes, including the terminator in width-zero maps. */
  findValue(key: BurikoBpPointer): BurikoBpPointer | null {
    return this.find(key)?.value ?? null;
  }

  private copy(entry: NamedEntry, output: BurikoBpPointer | null): void {
    if (output === null) return;
    const bytes = entry.value.bytes,
      destination = pointerView(output, bytes.length);
    new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength).set(bytes);
  }

  /** 09dc50: a null output queries existence without copying. */
  readByName(output: BurikoBpPointer | null, key: BurikoBpPointer): 0 | 0x80000001 {
    const entry = this.find(key);
    if (entry === null) return 0x80000001;
    this.copy(entry, output);
    return 0;
  }

  /** 09dbf0: signed insertion-order index; its missing status differs from named lookup. */
  readByIndex(output: BurikoBpPointer | null, index: number): 0 | 0x80000002 {
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
  remove(key: BurikoBpPointer): 0 | 0x80000001 {
    const hash = burikoNamedValueHash(key);
    const entry = this.findHashed(key, hash);
    if (entry === null) return 0x80000001;
    let previous: NamedEntry | null = null;
    for (let current = this.first; current !== entry; current = current!.next) previous = current;
    if (previous === null) this.first = entry.next;
    else previous.next = entry.next;
    if (this.last === entry) this.last = previous;
    const bucket = this.buckets.get(hash)!;
    if (bucket.length === 1) this.buckets.delete(hash);
    else bucket.splice(bucket.indexOf(entry), 1);
    entry.value.release();
    return 0;
  }

  /** 09deb0 repeatedly removes the live head. */
  clear(): void {
    while (this.first !== null) {
      const head = this.first;
      this.first = head.next;
      head.value.release();
    }
    this.last = null;
    this.buckets.clear();
  }

  /** Used by 09db60 over the imported-language owner, whose global registry remains separate. */
  *valuePointers(): IterableIterator<BurikoBpPointer> {
    for (let entry = this.first; entry !== null; entry = entry.next) yield entry.value;
  }
}
