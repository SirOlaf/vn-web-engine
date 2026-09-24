import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import {textByte, textBytes, writeText} from './text.js';

interface Entry {
  values: number[];
  strings: (Uint8Array | null)[];
}
function required(pointer: AokanaBpPointer | null): AokanaBpPointer {
  if (pointer === null) throw new RangeError('Aokana backlog consumed a null native pointer');
  return pointer;
}
/** C2960/C2700/C24F0: distinct backlog sentinel1E90B0 and count1E90A8. */
export class AokanaBacklog {
  private entries: Entry[] = [];
  private capacity = 0;
  get count(): number {
    return this.entries.length >>> 0;
  }
  reset(capacity: number): void {
    this.entries = [];
    this.capacity = capacity >>> 0;
  }
  append(values: readonly number[], pointers: readonly (AokanaBpPointer | null)[]): number {
    const strings: (Uint8Array | null)[] = [];
    for (let i = 0; i < 5; i++) {
      const pointer = pointers[i] ?? null;
      if (pointer === null && i !== 3) {
        strings.push(null);
        continue;
      }
      const bytes = textBytes(required(pointer), true);
      if (bytes.length > (i < 3 ? 32 : i === 3 ? 256 : 512)) return (0x80000001 + i) >>> 0;
      strings.push(bytes.slice());
    }
    this.entries.push({values: values.map((v) => v >>> 0), strings});
    if (this.entries.length > this.capacity) this.entries.shift();
    return 0;
  }
  /** C2620 reads scalar/optional-pointer fields in the actual native instruction order. */
  import(source: AokanaBpPointer | null): number {
    const pointer = required(source),
      values = new Array<number>(9);
    const word = (offset: number): number =>
      pointerView({bytes: pointer.bytes, offset: pointer.offset + offset}, 4).getUint32(0, true);
    const optional = (offset: number): AokanaBpPointer | null =>
      textByte(pointer.bytes, pointer.offset + offset) === 0
        ? null
        : {bytes: pointer.bytes, offset: pointer.offset + offset};
    values[8] = word(0x5c);
    values[7] = word(0x58);
    values[6] = word(0x54);
    values[4] = word(0x4c);
    values[5] = word(0x50);
    values[3] = word(0x48);
    const reading = optional(0x200);
    values[2] = word(0x44);
    const name = optional(0xe0),
      file = optional(0xc0),
      archive = optional(0xa0);
    values[1] = word(0x40);
    values[0] = word(0);
    return this.append(values, [
      archive,
      file,
      name,
      {bytes: pointer.bytes, offset: pointer.offset + 0x100},
      reading,
    ]);
  }
  read(destination: AokanaBpPointer | null, index: number, extended: boolean): 0 | 1 {
    index >>>= 0;
    if (index >= this.count) return 0;
    const pointer = required(destination),
      entry = this.entries[this.entries.length - 1 - index]!,
      output = pointerView(pointer, 0x200);
    new Uint8Array(output.buffer, output.byteOffset, output.byteLength).fill(0);
    output.setUint32(0, entry.values[0]!, true);
    for (let i = 1; i < 9; i++) output.setUint32(0x3c + i * 4, entry.values[i]!, true);
    for (let i = 0; i < 5; i++) {
      if (i === 4 && !extended) break;
      const bytes = entry.strings[i];
      if (bytes !== null && bytes !== undefined)
        writeText(
          {
            bytes: pointer.bytes,
            offset: pointer.offset + (i < 3 ? 0xa0 + i * 32 : i === 3 ? 0x100 : 0x200),
          },
          bytes,
        );
    }
    return 1;
  }
}
