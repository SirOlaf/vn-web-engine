import type {AokanaBpPointer} from '../bp/memory.js';
import {textBytes} from './text.js';

/** F8000: snapshot the byte string, trim ASCII spaces and collapse their runs.
 * Returned bytes exclude NUL; other byte values are retained without text decoding. */
export function normalizeAokanaAsciiSpaces(source: AokanaBpPointer): Uint8Array {
  const input = textBytes(source).slice();
  if (input.length === 0)
    throw new Error('Aokana native space normalization requires a nonempty source record');
  const output: number[] = [];
  let space = false;
  for (const value of input) {
    if (value === 32) {
      space = output.length !== 0;
      continue;
    }
    if (space) output.push(32);
    output.push(value);
    space = false;
  }
  return Uint8Array.from(output);
}
