import {romByte} from './text-rom.js';
import type {TextHost} from './tips-text.js';
/** 14005d7c0 truncates the decimal string to the requested number of characters. */
export const nativeDecimal = (value: number, width: number) =>
  (value | 0).toString().padStart(width, ' ').slice(0, width);
/** The native menu ASCII-to-glyph loop, including unknown-character substitution. */
export function encodeMenuAscii(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of text) {
    let id = 0;
    while (romByte(0x1da080 + id) !== 0 && romByte(0x1da080 + id) !== ch.charCodeAt(0)) id++;
    if (!romByte(0x1da080 + id)) id = 0;
    bytes.push(128 | (id >>> 8), id & 255);
  }
  bytes.push(255);
  return Uint8Array.from(bytes);
}
/** 140046430, preserving expression bytes while evaluating each copied expression. */
export function copyMenuText(
  host: Pick<TextHost, 'byte' | 'expression'>,
  address: number,
): Uint8Array {
  const out: number[] = [];
  while (host.byte(address) !== 255) {
    const b = host.byte(address);
    let end: number;
    if (b >= 128) end = address + 2;
    else if (b === 4) end = host.expression(address + 1).next;
    else throw new Error(`Native encoded-string copy cannot advance on control ${b}`);
    while (address < end) out.push(host.byte(address++));
  }
  out.push(255);
  return Uint8Array.from(out);
}
