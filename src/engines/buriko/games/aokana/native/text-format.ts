import type {AokanaBpPointer} from '../bp/memory.js';
import {pop32} from '../bp/state.js';
import type {AokanaBpOpcodeContext} from './types.js';
import {AokanaNativeText, textByte} from './text.js';

interface Conversion {
  flags: number;
  width: number;
  precision: number;
}

function checkedLength(length: number): number {
  if (length >= 0x10000)
    throw new RangeError('Aokana VM formatter exceeds its 65536-wchar allocation');
  return length;
}

/** The executable selects CRT options=0: decimal ties round away from zero (14002e530). */
function fixedDecimal(raw: number, precision: number): string {
  checkedLength(precision + 2);
  const magnitude = BigInt(Math.abs(raw | 0));
  const exactPrecision = Math.min(precision, 16);
  const scaled = magnitude * 10n ** BigInt(exactPrecision);
  const rounded = (scaled + 32768n) / 65536n;
  let digits = rounded.toString().padStart(exactPrecision + 1, '0');
  if (exactPrecision !== 0)
    digits = digits.slice(0, -exactPrecision) + '.' + digits.slice(-exactPrecision);
  return digits + '0'.repeat(precision - exactPrecision);
}

function renderConversion(spec: Conversion, kind: string, value: number | string): string {
  let {flags, width, precision} = spec;
  let prefix = '',
    content: string;
  if (kind === 'd' || kind === 'x' || kind === 'X') {
    const integer = kind === 'd' ? Number(value) | 0 : Number(value) >>> 0;
    if (kind === 'd') prefix = integer < 0 ? '-' : flags & 2 ? ' ' : '';
    if (precision < 0) precision = 1;
    else flags &= ~8;
    checkedLength(precision);
    content =
      integer === 0 && precision === 0 ? '' : Math.abs(integer).toString(kind === 'd' ? 10 : 16);
    if (kind === 'X') content = content.toUpperCase();
    content = content.padStart(precision, '0');
  } else if (kind === 'f') {
    const integer = Number(value) | 0;
    prefix = integer < 0 ? '-' : flags & 2 ? ' ' : '';
    content = fixedDecimal(integer, precision < 0 ? 6 : precision);
  } else {
    content = String(value);
    if (kind === 's' && precision >= 0) content = content.slice(0, precision);
  }
  const padding = Math.max(0, width - prefix.length - content.length);
  checkedLength(prefix.length + content.length + padding);
  if (flags & 4) return prefix + content + ' '.repeat(padding);
  if (flags & 8) return prefix + '0'.repeat(padding) + content;
  return ' '.repeat(padding) + prefix + content;
}

/** Reachable states of the native CRT parser, including malformed flag sequences becoming literals. */
function formatOne(format: string, value: number | string): string {
  let state = 0,
    output = '';
  const spec: Conversion = {flags: 0, width: 0, precision: -1};
  for (let index = 0; index < format.length; index++) {
    const character = format[index]!;
    const digit = character >= '0' && character <= '9';
    if (character === '%') state = state === 0 || state === 7 ? 1 : 0;
    else if (character === ' ' || character === '-') state = state === 1 || state === 2 ? 2 : 0;
    else if (character === '.') state = state >= 1 && state <= 3 ? 4 : 0;
    else if (digit) {
      state =
        character === '0' && (state === 1 || state === 2)
          ? 2
          : state >= 1 && state <= 3
            ? 3
            : state === 4 || state === 5
              ? 5
              : 0;
    } else state = state >= 1 && state <= 6 ? 7 : 0;

    if (state === 0) output += character;
    else if (state === 1) {
      spec.flags = 0;
      spec.width = 0;
      spec.precision = -1;
    } else if (state === 2) spec.flags |= character === ' ' ? 2 : character === '-' ? 4 : 8;
    else if (state === 4) spec.precision = 0;
    else if (state === 3 || state === 5) {
      let number = 0;
      do {
        number = number * 10 + Number(format[index]);
        if (number > 0x7fffffff)
          throw new RangeError('Aokana CRT formatter decimal field overflows int32');
        index++;
      } while (format[index]! >= '0' && format[index]! <= '9');
      index--;
      if (state === 3) spec.width = number;
      else spec.precision = number;
    } else if (state === 7) output += renderConversion(spec, character, value);
    checkedLength(output.length);
  }
  return output;
}

/** 1400f78a0. The result includes the original terminator and any embedded raw %c NUL bytes. */
export function formatVmText(
  h: AokanaBpOpcodeContext,
  format: AokanaBpPointer,
  text: AokanaNativeText,
): Uint8Array {
  const wideFormat = text.decodeAuto(format);
  const rawCharacters: number[] = [];
  let wideOutput = '';
  for (let index = 0; index < wideFormat.length;) {
    if (wideFormat[index] !== '%') {
      wideOutput += wideFormat[index++]!;
      checkedLength(wideOutput.length);
      continue;
    }
    let end = index + 1;
    while (
      wideFormat[end] === ' ' ||
      wideFormat[end] === '-' ||
      wideFormat[end] === '.' ||
      (wideFormat[end]! >= '0' && wideFormat[end]! <= '9')
    )
      end++;
    if (end - index + 2 > 256)
      throw new RangeError('Aokana VM formatter exceeds its 256-wchar conversion buffer');
    const kind = wideFormat[end];
    if (kind === undefined) throw new Error('Aokana VM formatter reached an unfinished conversion');
    if (kind === '%') wideOutput += '%';
    else {
      let value: number | string;
      if (kind === 's') {
        const source = h.memory.resolve(h.thread, pop32(h.thread));
        if (source === null)
          throw new Error('Aokana text encoding detector dereferences a null %s operand');
        value = text.decodeAuto(source);
      } else if (kind === 'c') {
        rawCharacters.push(pop32(h.thread) & 255);
        value = '\x1a';
      } else if (kind === 'd' || kind === 'x' || kind === 'X' || kind === 'f')
        value = pop32(h.thread);
      else throw new Error(`Aokana VM formatter rejects conversion ${kind}`);
      wideOutput += formatOne(wideFormat.slice(index, end + 1), value);
    }
    checkedLength(wideOutput.length);
    index = end + 1;
  }
  const output = text.encodeWide(wideOutput);
  let rawIndex = 0;
  for (let offset = 0; textByte(output, offset) !== 0;) {
    if (output[offset] === 0x1a) {
      const value = rawCharacters[rawIndex++];
      if (value === undefined)
        throw new Error('Aokana VM formatter dereferences an empty raw-character list');
      output[offset++] = value;
    } else offset += text.readCharacter(output, offset).length;
  }
  return output;
}
