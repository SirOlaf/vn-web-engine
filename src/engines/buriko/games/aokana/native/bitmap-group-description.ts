import type {AokanaBpMemory, AokanaBpPointer} from '../bp/memory.js';
import type {AokanaBpThread} from '../bp/state.js';
import {pointerBytes} from '../bp/opcodes/operands.js';
import {AokanaNativeText, writeText} from './text.js';

export interface AokanaBitmapGroupDescription {
  /** Original VM DWORD fields; the tagged pointer field is replaced by groups below when consumed. */
  readonly words: Uint32Array;
  readonly groups: readonly AokanaBitmapUnitGroup[];
}
export interface AokanaBitmapUnitGroup {
  /** Original 0x40-byte-stride VM record, including the full DWORD at offset zero. */
  readonly words: Uint32Array;
  readonly units: Uint8Array;
}
function read(pointer: AokanaBpPointer | null, word: number): number {
  if (pointer === null)
    throw new Error('Aokana bitmap-group conversion dereferences a null description');
  const bytes = pointerBytes(pointer, 4, word * 4);
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
}

/** 1400c3100 converts all source records before any caller output is written.
 * Shared by the window B0-prefix pool and the type-80 DCIP description path. */
export function copyAokanaBitmapGroupDescription(
  source: AokanaBpPointer | null,
  memory: AokanaBpMemory,
  thread: AokanaBpThread,
): {result: 0; description: AokanaBitmapGroupDescription} | {result: 2 | 3} {
  const words = new Uint32Array(10);
  words[0] = read(source, 0);
  for (let index = 2; index < 10; index++) words[index] = read(source, index);
  words[1] = read(source, 1);
  const groupPointer = memory.resolve(thread, words[1]!);
  if (groupPointer === null || (words[0]! - 1) >>> 0 > 255) return {result: 2};
  const groups: AokanaBitmapUnitGroup[] = [];
  for (let group = 0; group < words[0]!; group++) {
    const pointer = {bytes: groupPointer.bytes, offset: groupPointer.offset + group * 0x40};
    const fields = new Uint32Array(16);
    fields[0] = read(pointer, 0);
    fields[1] = read(pointer, 1);
    for (let index = 3; index < 16; index++) fields[index] = read(pointer, index);
    fields[2] = read(pointer, 2);
    const sourceUnits = memory.resolve(thread, fields[2]!);
    const count = fields[0]! & 0xffff;
    if (sourceUnits === null || (count - 1) >>> 0 > 1023) return {result: 3};
    groups.push({words: fields, units: pointerBytes(sourceUnits, count * 0xc4).slice()});
  }
  return {result: 0, description: {words, groups}};
}

function signed(value: number, width = 0, space = false): string {
  value |= 0;
  return (value >= 0 && space ? ' ' + value : String(value)).padStart(width, ' ');
}

/** 140092f40 uses the FULL signed group count, despite c3100 allocating only its low 16 bits. */
export function formatAokanaBitmapGroups(
  output: AokanaBpPointer | null,
  description: AokanaBitmapGroupDescription,
  text: AokanaNativeText,
): number {
  let wide = '';
  for (let group = 0; group < (description.words[0]! | 0); group++) {
    wide += `- Group [ ${group} ] -\n\n`;
    const current = description.groups[group];
    if (!current) throw new Error('Aokana bitmap formatter reads an unwritten native group record');
    for (let unit = 0; unit < (current.words[0]! | 0); unit++) {
      const bytes = pointerBytes({bytes: current.units, offset: unit * 0xc4}, 0xc4);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const n = (word: number): number => view.getInt32(word * 4, true);
      wide += `\tUnit [ ${signed(unit, 3, true)} ] / Validity : ${n(0) === 0 ? 'FALSE' : 'TRUE '} / Visibility : ${n(1) === 0 ? 'FALSE' : 'TRUE '} / `;
      wide += `Position( ${signed(n(2), 4, true)}, ${signed(n(3), 4, true)} ) / Origin( ${signed(n(4), 4, true)}, ${signed(n(5), 4, true)} ) / `;
      wide += `Bitmaps : ${n(6)} / ChangeInterval : ${n(7)} / BaseBitmaps( ${n(8)}, ${n(9)}, ${n(10)}, ${n(11)} ) / BitmapForVPD : ${n(12)}\n`;
    }
    wide += '\n';
  }
  const encoded = text.encodeWide(wide);
  if (output !== null) writeText(output, encoded);
  return (encoded.length - 1) >>> 0;
}
