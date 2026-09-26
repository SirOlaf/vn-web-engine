import {pointerView, type BurikoBpPointer} from '../bp/memory.js';
import {textByte} from './text.js';
function bytesAt(pointer: BurikoBpPointer | null, offset: number, length: number): Uint8Array {
  if (pointer === null)
    throw new RangeError('Buriko record history consumed a null native pointer');
  const view = pointerView({bytes: pointer.bytes, offset: pointer.offset + offset}, length);
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}
/** C2350/C24B0: zero runs alternate with literals containing isolated zero bytes. */
export function encodeBurikoRecord(input: Uint8Array): Uint8Array {
  const output = new Uint8Array((input.length + 11) >>> 0);
  let target = 0,
    source = 0;
  const write = (value: number): void => {
    if (target >= output.length)
      throw new RangeError('Buriko record encoder exceeds native scratch');
    output[target++] = value;
  };
  const integer = (value: number): void => {
    value >>>= 0;
    do {
      const next = value >>> 7;
      write((value & 127) | (next === 0 ? 0 : 128));
      value = next;
    } while (value !== 0);
  };
  integer(input.length);
  do {
    let count = 0;
    while (source < input.length && input[source] === 0) {
      count++;
      source++;
    }
    integer(count);
    if (source >= input.length) break;
    const start = source;
    while (source < input.length) {
      if (input[source] === 0 && source + 1 < input.length && input[source + 1] === 0) break;
      source++;
    }
    integer(source - start);
    for (let i = start; i < source; i++) write(input[i]!);
  } while (source < input.length);
  return output.slice(0, target);
}
/** C2280/C2440 writes each actual run into caller storage, preserving native write ordering. */
export function decodeBurikoRecord(destination: BurikoBpPointer | null, input: Uint8Array): number {
  let source = 0,
    produced = 0;
  const integer = (): number => {
    let value = 0,
      shift = 0,
      byte: number;
    do {
      byte = textByte(input, source);
      source = (source + 1) >>> 0;
      value |= (byte & 127) << (shift & 31);
      shift = (shift + 7) >>> 0;
    } while ((byte & 128) !== 0);
    return value >>> 0;
  };
  const total = integer();
  while (produced < total) {
    let count = integer();
    if (count !== 0) {
      bytesAt(destination, produced, count).fill(0);
      produced = (produced + count) >>> 0;
    }
    if (produced >= total) break;
    count = integer();
    if (count !== 0) {
      const sourceBytes = bytesAt({bytes: input, offset: 0}, source, count);
      bytesAt(destination, produced, count).set(sourceBytes);
      produced = (produced + count) >>> 0;
      source = (source + count) >>> 0;
    }
  }
  return produced === total ? total : 0;
}
interface RecordEntry {
  mode: number;
  bytes: Uint8Array;
}
interface History {
  id: number;
  capacity: number;
  size: number;
  mode: number;
  records: RecordEntry[];
}
/** C21B0–C2250 owns1E9088 identifiers and1E90A0, separately from the backlog. */
export class BurikoRecordHistories {
  private identifier = 0;
  private histories: History[] = [];
  private find(id: number): History | undefined {
    return this.histories.find((h) => h.id === id >>> 0);
  }
  create(output: BurikoBpPointer | null, capacity: number, size: number): number {
    capacity >>>= 0;
    size >>>= 0;
    if (capacity === 0 || size === 0) return 2;
    this.identifier = (this.identifier + 1) >>> 0;
    const history: History = {id: this.identifier, capacity, size, mode: 1, records: []};
    this.histories.unshift(history);
    const bytes = bytesAt(output, 0, 4);
    new DataView(bytes.buffer, bytes.byteOffset, 4).setUint32(0, history.id, true);
    return 0;
  }
  remove(id: number): number {
    const index = this.histories.findIndex((h) => h.id === id >>> 0);
    if (index < 0) return 1;
    this.histories.splice(index, 1);
    return 0;
  }
  clear(): void {
    this.histories = [];
  }
  count(output: BurikoBpPointer | null, id: number): number {
    const history = this.find(id);
    if (history === undefined) return 1;
    const bytes = bytesAt(output, 0, 4);
    new DataView(bytes.buffer, bytes.byteOffset, 4).setUint32(
      0,
      history.records.length >>> 0,
      true,
    );
    return 0;
  }
  append(id: number, source: BurikoBpPointer | null): number {
    const history = this.find(id);
    if (history === undefined) return 1;
    const input = bytesAt(source, 0, history.size),
      bytes = history.mode === 1 ? encodeBurikoRecord(input) : input.slice();
    history.records.unshift({mode: history.mode, bytes});
    if (history.records.length > history.capacity) history.records.length = history.capacity;
    return 0;
  }
  read(output: BurikoBpPointer | null, id: number, index: number): number {
    const history = this.find(id);
    if (history === undefined) return 1;
    const entry = history.records[index >>> 0];
    if (entry === undefined) return 2;
    // C1EC0 deliberately uses the current history mode, not entry.mode.
    if (history.mode === 1) decodeBurikoRecord(output, entry.bytes);
    else
      bytesAt(output, 0, history.size).set(
        bytesAt({bytes: entry.bytes, offset: 0}, 0, history.size),
      );
    return 0;
  }
  removeRange(id: number, index: number, count: number): number {
    const history = this.find(id);
    if (history === undefined) return 1;
    index >>>= 0;
    count >>>= 0;
    if (index >= history.records.length) return 2;
    history.records.splice(index, count);
    return 0;
  }
  setMode(id: number, mode: number): number {
    const history = this.find(id);
    if (history === undefined) return 1;
    mode >>>= 0;
    if (mode >= 2) return 2;
    history.mode = mode;
    return 0;
  }
}
