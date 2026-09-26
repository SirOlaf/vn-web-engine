import {pointerView, type BurikoBpPointer} from '../bp/memory.js';
import {BurikoNamedValueMap} from './named-value-map.js';
import {BurikoNativeText, textLength} from './text.js';

/** 2776E0 is one outer width-eight map containing actual inner width-zero map references. */
export class BurikoImportedTextMaps {
  private outer: BurikoNamedValueMap | null = null;

  constructor(readonly text: BurikoNativeText) {}

  /** FCEF0 snapshots the outer value pointers, clears each inner map, then the outer owner. */
  clear(): void {
    const outer = this.outer;
    if (outer === null) return;
    for (const value of [...outer.valuePointers()]) {
      const inner = outer.referenceFromValuePointer(value);
      if (inner !== null) (inner as BurikoNamedValueMap).clear();
    }
    outer.clear();
    this.outer = null;
  }

  /** FD0F0 appends/replaces imported groups; the size comparison occurs after all parsing. */
  import(input: BurikoBpPointer | null, size: number): boolean {
    if (input === null) {
      this.clear();
      return true;
    }
    const outer = (this.outer ??= new BurikoNamedValueMap(8));
    let cursor = input.offset;
    const pointer = (): BurikoBpPointer => ({bytes: input.bytes, offset: cursor});
    const count = (): number => {
      const value = pointerView(pointer(), 4).getUint32(0, true);
      cursor += 4;
      return value;
    };
    const groups = count();
    for (let index = 0; index < groups; index++) {
      const inner = new BurikoNamedValueMap(0),
        name = pointer();
      outer.insertReference(name, inner);
      cursor += (textLength(name) + 1) >>> 0;
      const entries = count();
      for (let entry = 0; entry < entries; entry++) {
        const key = pointer();
        cursor += (textLength(key) + 1) >>> 0;
        const value = pointer();
        inner.insert(key, value);
        cursor += (textLength(value) + 1) >>> 0;
      }
    }
    return size >>> 0 === cursor - input.offset;
  }

  /** FD060 converts the group first; the inner name is converted only for a matching group. */
  lookup(group: BurikoBpPointer | null, key: BurikoBpPointer | null): BurikoBpPointer | null {
    if (this.outer === null) return null;
    if (group === null) throw new Error('Buriko imported text null group name');
    const groupUtf8 = this.text.convertEncoding(group, 1),
      inner = this.outer.findReference({bytes: groupUtf8, offset: 0});
    if (inner === null) return null;
    if (key === null) throw new Error('Buriko imported text null entry name');
    const keyUtf8 = this.text.convertEncoding(key, 1);
    return (inner as BurikoNamedValueMap).findValue({bytes: keyUtf8, offset: 0});
  }
}
