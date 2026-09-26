import {pointerView, type AokanaBpMemory, type AokanaBpPointer} from '../bp/memory.js';
import type {AokanaBpThread} from '../bp/state.js';

/** Sparse DWORD records preserve C34E0's unwritten native padding. */
export class AokanaIconWords {
  constructor(readonly words: (number | undefined)[]) {}
  read(index: number): number {
    const value = this.words[index];
    if (value === undefined)
      throw new Error('Aokana icon consumes an unwritten native record field');
    return value | 0;
  }
  write(index: number, value: number): void {
    this.words[index] = value | 0;
  }
  clone(): AokanaIconWords {
    return new AokanaIconWords(this.words.slice());
  }
}
export interface AokanaIconRow {
  data: AokanaIconWords;
  icons: AokanaIconWords[];
}
export interface AokanaIconDescription {
  header: AokanaIconWords;
  rows: AokanaIconRow[];
}
export function iconPointerWord(pointer: AokanaBpPointer | null, index: number): DataView {
  if (pointer === null) throw new Error('Aokana icon dereferences a null VM record');
  return pointerView({bytes: pointer.bytes, offset: pointer.offset + index * 4}, 4);
}
/** C34E0 copies VM header32/row52/icon60 into native header40/row64/icon72. */
export function copyAokanaIconDescription(
  memory: AokanaBpMemory,
  thread: AokanaBpThread,
  source: AokanaBpPointer | null,
): {status: 0; description: AokanaIconDescription} | {status: 2 | 3} {
  const read = (p: AokanaBpPointer | null, i: number) => iconPointerWord(p, i).getInt32(0, true);
  const header = new AokanaIconWords(Array(10));
  header.write(0, read(source, 0));
  for (let i = 2; i < 8; i++) header.write(i + 2, read(source, i));
  const rowPointer = memory.resolve(thread, read(source, 1));
  if (rowPointer === null) return {status: 2};
  const count = read(source, 0);
  if ((count - 1) >>> 0 > 255) return {status: 2};
  const rows: AokanaIconRow[] = [];
  let status: 0 | 3 = 0;
  for (let i = 0; i < read(source, 0); i++) {
    if (status !== 0) continue;
    const p = {bytes: rowPointer.bytes, offset: rowPointer.offset + i * 52};
    const data = new AokanaIconWords(Array(16));
    data.write(0, read(p, 0));
    for (let j = 2; j < 13; j++) data.write(j + 2, read(p, j));
    const iconPointer = memory.resolve(thread, read(p, 1));
    const n = read(p, 0) & 0xffff;
    if (iconPointer === null || (n - 1) >>> 0 > 1023) {
      status = 3;
      continue;
    }
    const icons: AokanaIconWords[] = [];
    for (let j = 0; j < n; j++) {
      const q = {bytes: iconPointer.bytes, offset: iconPointer.offset + j * 60};
      const words = new AokanaIconWords(Array(18));
      for (let k = 0; k < 13; k++) words.write(k, read(q, k));
      words.write(14, 0);
      words.write(15, 0);
      words.write(16, read(q, 14));
      icons.push(words);
    }
    rows.push({data, icons});
  }
  return status === 0 ? {status, description: {header, rows}} : {status};
}
