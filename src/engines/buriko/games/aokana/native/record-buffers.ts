import {pointerView} from '../bp/memory.js';
import type {AokanaBpPointer} from '../bp/memory.js';

interface RecordSet {
  id: number;
  capacity: number;
  records: Map<number, Uint8Array>;
}
function outputWord(pointer: AokanaBpPointer | null, value: number): void {
  if (pointer === null) throw new Error('Aokana native record-set null DWORD output');
  pointerView(pointer, 4).setUint32(0, value, true);
}

/** C03xx–C0640 record-set registry over the 08DB10–08DE80 doubling slot table. */
export class AokanaNativeRecordBuffers {
  private nextId = 0;
  // Newest-first lookup preserves the native linked-list behavior even when DWORD ids wrap.
  private readonly sets: RecordSet[] = [];

  create(destination: AokanaBpPointer | null, capacity: number): number {
    capacity >>>= 0;
    if (capacity < 2) return 0x80000001;
    this.nextId = (this.nextId + 1) >>> 0;
    this.sets.unshift({id: this.nextId, capacity, records: new Map()});
    outputWord(destination, this.nextId);
    return 0;
  }

  destroy(id: number): number {
    const index = this.sets.findIndex((set) => set.id === id >>> 0);
    if (index < 0) return 0x80000002;
    this.sets.splice(index, 1);
    return 0;
  }

  /** C0640 destroys the entire registry, then resets its ID counter for the next program. */
  clear(): void {
    this.sets.length = 0;
    this.nextId = 0;
  }

  private find(id: number): RecordSet | undefined {
    return this.sets.find((set) => set.id === id >>> 0);
  }

  write(
    indexOutput: AokanaBpPointer | null,
    id: number,
    index: number,
    source: AokanaBpPointer | null,
    size: number,
  ): number {
    const set = this.find(id);
    if (set === undefined) return 0x80000002;
    index >>>= 0;
    size >>>= 0;
    if (indexOutput !== null) {
      index = 0;
      while (index < set.capacity && set.records.has(index)) index++;
      if (index >= 0x80000000) index = set.capacity;
    }
    if (size === 0) return 0x80000003;
    if (index < set.capacity) set.records.delete(index);
    else {
      let capacity = set.capacity;
      do {
        const doubled = (capacity * 2) >>> 0;
        if (doubled === 0)
          throw new Error(
            'Aokana native record-table DWORD growth reaches a nonterminating zero capacity',
          );
        capacity = doubled;
      } while (capacity <= index);
      set.capacity = capacity;
    }
    const bytes = new Uint8Array(size);
    set.records.set(index, bytes);
    if (source === null) throw new Error('Aokana native record-copy null source');
    pointerView(source, size);
    bytes.set(source.bytes.subarray(source.offset, source.offset + size));
    if (indexOutput !== null) outputWord(indexOutput, index);
    return 0;
  }

  remove(id: number, index: number): number {
    const set = this.find(id);
    if (set === undefined) return 0x80000002;
    if (!set.records.delete(index >>> 0)) return 0x80000004;
    return 0;
  }

  read(
    destination: AokanaBpPointer | null,
    sizeOutput: AokanaBpPointer | null,
    id: number,
    index: number,
  ): number {
    const set = this.find(id);
    if (set === undefined) return 0x80000002;
    const bytes = set.records.get(index >>> 0);
    if (bytes === undefined) return 0x80000004;
    if (destination !== null) {
      // Native memcpy sign-extends the stored size from its DWORD record field.
      if (bytes.length >= 0x80000000)
        throw new Error('Aokana native record-copy signed length exceeds addressable memory');
      pointerView(destination, bytes.length);
      destination.bytes.set(bytes, destination.offset);
    }
    outputWord(sizeOutput, bytes.length);
    return 0;
  }

  enumerate(
    destination: AokanaBpPointer | null,
    countOutput: AokanaBpPointer | null,
    id: number,
  ): number {
    const set = this.find(id);
    if (set === undefined) return 0x80000002;
    const records = [...set.records].sort(([left], [right]) => left - right);
    if (destination !== null && records.length !== 0) {
      const temporary = new Uint8Array(records.length * 8),
        view = new DataView(temporary.buffer);
      for (let record = 0; record < records.length; record++) {
        const [index, bytes] = records[record]!;
        view.setUint32(record * 8, index, true);
        view.setUint32(record * 8 + 4, bytes.length, true);
      }
      pointerView(destination, temporary.length);
      destination.bytes.set(temporary, destination.offset);
    }
    outputWord(countOutput, records.length);
    return 0;
  }
}
