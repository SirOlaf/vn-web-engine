import type {AokanaBpPointer} from '../bp/memory.js';
import {classifyUtf8, textByte, textBytes} from './text.js';

/** 1400ccef0's mixed-encoding dump, including multibyte characters crossing a16-byte row. */
export function formatAokanaMemoryDump(pointer: AokanaBpPointer | null, count: number, title: AokanaBpPointer | null): Uint8Array {
  if (((count >>> 0) - 1) >>> 0 > 0x3ff) throw new RangeError('Aokana dump count must be1..1024');
  if (pointer === null) throw new Error('Aokana memory dump dereferences null');
  const encoder = new TextEncoder(), parts: Uint8Array[] = [];
  let remaining = count >>> 0, offset = 0, carry = 0;
  while (remaining > 0) {
    const rowLength = Math.min(remaining, 16);
    let hexadecimal = '';
    for (let index = 0; index < rowLength; index++) hexadecimal += textByte(pointer.bytes, pointer.offset + offset + index).toString(16).toUpperCase().padStart(2, '0') + ' ';
    const characters = new Uint8Array(256);
    characters.fill(32, 0, carry);
    let index = carry;
    while (index < rowLength) {
      const position = pointer.offset + offset + index;
      const sequence = classifyUtf8(pointer.bytes, position);
      let length: number;
      if (sequence.result === 0x80000000) {
        length = 1;
        characters[index] = Math.max(32, textByte(pointer.bytes, position));
      } else {
        length = sequence.result === 0 ? 2 : sequence.length!;
        for (let byte = 0; byte < length; byte++) characters[index + byte] = textByte(pointer.bytes, position + byte);
      }
      index += length;
      carry = (carry + length) & 15;
    }
    characters[index] = 0;
    parts.push(encoder.encode(`\n0x${offset.toString(16).toUpperCase().padStart(4, '0')} : ${hexadecimal} `), textBytes({bytes: characters, offset: 0}));
    remaining = Math.max(0, remaining - 16);
    offset += 16;
  }
  const prefix = title === null ? encoder.encode('(null)') : textBytes(title);
  parts.unshift(prefix, Uint8Array.of(10, 10));
  const length = parts.reduce((sum, bytes) => sum + bytes.length, 1);
  if (length > 0x4000) throw new RangeError('Aokana memory dump exceeds native output storage');
  const result = new Uint8Array(length);
  let cursor = 0;
  for (const part of parts) { result.set(part, cursor); cursor += part.length; }
  return result;
}
