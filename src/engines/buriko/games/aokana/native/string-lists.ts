import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import {aokanaCompareNamedBytes, aokanaNamedValueHash} from './named-value-map.js';
import {textLength} from './text.js';

interface StringEntry {
  readonly hash: number;
  readonly length: number;
  readonly value: AokanaBpPointer;
}
class StringList {
  readonly entries: Array<StringEntry | undefined>;
  next: StringList | null = null;
  constructor(
    readonly id: number,
    public capacity: number,
    public count: number,
  ) {
    this.entries = new Array<StringEntry | undefined>(capacity);
  }
  entry(index: number): StringEntry {
    const entry = this.entries[index];
    if (entry === undefined) throw new Error('Aokana string list reads an undefined native entry');
    return entry;
  }
}

/** F9060..F94E0, the one numbered string-list registry at1CA4F0. */
export class AokanaStringLists {
  private first: StringList | null = null;

  private find(id: number): StringList | null {
    id >>>= 0;
    for (let list = this.first; list !== null; list = list.next) if (list.id === id) return list;
    return null;
  }
  private prepend(list: StringList): void {
    list.next = this.first;
    this.first = list;
  }
  private copyEntry(source: AokanaBpPointer, hash: number): StringEntry {
    const length = (textLength(source) + 1) >>> 0,
      view = pointerView(source, length),
      bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
    return {hash, length, value: {bytes, offset: 0}};
  }

  /** F90C0 removes the first matching list before releasing its stored strings. */
  destroy(id: number): 0 | 1 {
    id >>>= 0;
    let previous: StringList | null = null;
    for (let list = this.first; list !== null; list = list.next) {
      if (list.id === id) {
        if (previous === null) this.first = list.next;
        else previous.next = list.next;
        list.entries.length = 0;
        return 1;
      }
      previous = list;
    }
    return 0;
  }

  /** F9200 optionally preserves the reserved80000000 list while walking the live links. */
  reset(preserveReserved: number): void {
    let previous: StringList | null = null,
      list = this.first;
    while (list !== null) {
      if ((preserveReserved | 0) === 0 || list.id !== 0x80000000) {
        this.destroy(list.id);
        list = previous === null ? this.first : previous.next;
      } else {
        previous = list;
        list = list.next;
      }
    }
  }
  count(id: number): number {
    return this.find(id)?.count ?? 0;
  }

  /** F94E0 links the replacement and records its full count before copying each input string. */
  replace(id: number, count: number, source: AokanaBpPointer | null): 0 | 1 {
    id >>>= 0;
    count |= 0;
    if (count === 0) {
      this.destroy(id);
      return 1;
    }
    if (count < 0 || source === null) return 0;
    this.destroy(id);
    let capacity = 32;
    while (capacity < count) {
      capacity = Math.imul(capacity, 2);
      if (capacity <= 0)
        throw new RangeError('Aokana string-list capacity exceeds its native numerical domain');
    }
    const list = new StringList(id, capacity, count);
    this.prepend(list);
    let offset = source.offset;
    for (let index = 0; index < count; index++) {
      const input = {bytes: source.bytes, offset},
        entry = this.copyEntry(input, aokanaNamedValueHash(input));
      list.entries[index] = entry;
      offset += entry.length;
    }
    return 1;
  }

  /** F9460 constructs a missing list before F8F10 validates/appends its source. */
  append(id: number, source: AokanaBpPointer | null): number {
    id >>>= 0;
    let list = this.find(id);
    if (list === null) {
      list = new StringList(id, 32, 0);
      this.prepend(list);
    }
    if (source === null) return 0xffffffff;
    const hash = aokanaNamedValueHash(source);
    for (let index = 0; index < (list.count | 0); index++) {
      const entry = list.entry(index);
      if (entry.hash === hash && aokanaCompareNamedBytes(source, entry.value) === 0) return index;
    }
    if (list.count === list.capacity) {
      list.capacity = Math.imul(list.capacity, 2);
      if (list.capacity <= 0)
        throw new RangeError('Aokana string-list capacity exceeds its native numerical domain');
      list.entries.length = list.capacity;
    }
    const index = list.count;
    list.entries[index] = this.copyEntry(source, hash);
    list.count = (list.count + 1) >>> 0;
    return index;
  }

  /** F9380 copies each retained byte length including NUL and returns the wrapping DWORD sum. */
  copyAll(output: AokanaBpPointer | null, id: number): number {
    const list = this.find(id);
    if (list === null) return 0;
    let total = 0,
      offset = output?.offset ?? 0;
    for (let index = 0; index < (list.count | 0); index++) {
      const entry = list.entry(index);
      if (output !== null) {
        const destination = pointerView({bytes: output.bytes, offset}, entry.length);
        new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength).set(
          entry.value.bytes,
        );
        offset += entry.length;
      }
      total = (total + entry.length) >>> 0;
    }
    return total;
  }

  /** F9160 copies text before optionally writing its length excluding the terminator. */
  read(
    output: AokanaBpPointer | null,
    lengthOutput: AokanaBpPointer | null,
    id: number,
    index: number,
  ): number {
    const list = this.find(id);
    if (list === null) return 0x80000001;
    index |= 0;
    if (index < 0 || index >= (list.count | 0)) return 0x80000002;
    const entry = list.entry(index);
    if (output !== null) {
      const destination = pointerView(output, entry.length);
      new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength).set(
        entry.value.bytes,
      );
    }
    if (lengthOutput !== null)
      pointerView(lengthOutput, 4).setUint32(0, (entry.length - 1) >>> 0, true);
    return 0;
  }
}
