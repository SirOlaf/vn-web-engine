import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import {AokanaNamedValueMap} from './named-value-map.js';
import {AokanaNativeText, textLength} from './text.js';

/** 2776E0 is one outer width-eight map containing actual inner width-zero map references. */
export class AokanaImportedTextMaps {
  private outer: AokanaNamedValueMap | null = null;

  constructor(readonly text: AokanaNativeText) {}

  /** FCEF0 snapshots the outer value pointers, clears each inner map, then the outer owner. */
  clear(): void {
    const outer = this.outer;
    if (outer === null) return;
    for (const value of [...outer.valuePointers()]) {
      const inner = outer.referenceFromValuePointer(value);
      if (inner !== null) (inner as AokanaNamedValueMap).clear();
    }
    outer.clear();
    this.outer = null;
  }

  /** FD0F0 appends/replaces imported groups; the size comparison occurs after all parsing. */
  import(input: AokanaBpPointer | null, size: number): boolean {
    if (input === null) {
      this.clear();
      return true;
    }
    const outer = (this.outer ??= new AokanaNamedValueMap(8));
    let cursor = input.offset;
    const pointer = (): AokanaBpPointer => ({bytes: input.bytes, offset: cursor});
    const count = (): number => {
      const value = pointerView(pointer(), 4).getUint32(0, true);
      cursor += 4;
      return value;
    };
    const groups = count();
    for (let index = 0; index < groups; index++) {
      const inner = new AokanaNamedValueMap(0),
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
  lookup(group: AokanaBpPointer | null, key: AokanaBpPointer | null): AokanaBpPointer | null {
    if (this.outer === null) return null;
    if (group === null) throw new Error('Aokana imported text null group name');
    const groupUtf8 = this.text.convertEncoding(group, 1),
      inner = this.outer.findReference({bytes: groupUtf8, offset: 0});
    if (inner === null) return null;
    if (key === null) throw new Error('Aokana imported text null entry name');
    const keyUtf8 = this.text.convertEncoding(key, 1);
    return (inner as AokanaNamedValueMap).findValue({bytes: keyUtf8, offset: 0});
  }
}
