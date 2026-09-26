import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import {AokanaNamedValueMap} from './named-value-map.js';

interface NamedMapEntry {
  readonly id: number;
  readonly map: AokanaNamedValueMap;
  next: NamedMapEntry | null;
}

/** F9D20..F9F70: the separate 2775D8 registry of fixed-width script maps. */
export class AokanaNamedValueMaps {
  private counter = 0; // 2775C8 has static zero initialization.
  private first: NamedMapEntry | null = null;

  find(id: number): AokanaNamedValueMap | null {
    id >>>= 0;
    for (let entry = this.first; entry !== null; entry = entry.next)
      if (entry.id === id) return entry.map;
    return null;
  }

  /** F9EC0 links the constructed map before storing the new ID at the output pointer. */
  create(output: AokanaBpPointer | null, width: number): number {
    width >>>= 0;
    if (width <= 1) return 0x80000001;
    this.counter = (this.counter + 1) >>> 0;
    this.first = {id: this.counter, map: new AokanaNamedValueMap(width), next: this.first};
    pointerView(output!, 4).setUint32(0, this.counter, true);
    return 0;
  }

  /** F9DD0 unlinks the first matching ID, then clears that map's actual entries. */
  destroy(id: number): number {
    id >>>= 0;
    let previous: NamedMapEntry | null = null;
    for (let entry = this.first; entry !== null; entry = entry.next) {
      if (entry.id === id) {
        if (previous === null) this.first = entry.next;
        else previous.next = entry.next;
        entry.map.clear();
        return 0;
      }
      previous = entry;
    }
    return 0x80000002;
  }

  /** F9D50 resets the creation counter only after removing every live map. */
  clear(): void {
    while (this.first !== null) this.destroy(this.first.id);
    this.counter = 0;
  }

  write(id: number, key: AokanaBpPointer | null, value: AokanaBpPointer | null): number {
    const map = this.find(id);
    if (map === null) return 0x80000002;
    // Native argument bytes are dereferenced by the concrete map, after registry lookup.
    map.insert(key!, value!);
    return 0;
  }

  remove(id: number, key: AokanaBpPointer | null): number {
    const map = this.find(id);
    if (map === null) return 0x80000002;
    return map.remove(key!) === 0 ? 0 : 0x80000003;
  }

  /** F9E60 uses the signed insertion index only when the supplied key pointer is null. */
  read(
    output: AokanaBpPointer | null,
    id: number,
    key: AokanaBpPointer | null,
    index: number,
  ): number {
    const map = this.find(id);
    if (map === null) return 0x80000002;
    const status = key === null ? map.readByIndex(output, index) : map.readByName(output, key);
    return status === 0 ? 0 : 0x80000003;
  }
}
