/** CIni (constructor 0x14009d200, parser 0x140176090, getter 0x140176b10) with the UTF-8
 * code page (2). Sections map to key/value byte strings.
 *
 * - Outside a section header or key: whitespace (tab, LF, CR, space) is skipped, `[` starts
 *   a section header, `;` a comment to the end of the line, and anything else starts a key.
 * - Section names end at `]`; key names at `=`. Both drop CR and take the byte after `\` as
 *   is. A key without `=` continues over line ends.
 * - Values end at LF and drop CR; `\` has no meaning there.
 * - Keys and values are trimmed (0x140176f30). A repeated key replaces the earlier value;
 *   a repeated section replaces the whole earlier section.
 * - Multibyte characters are copied whole, so their bytes never act as syntax.
 */
export class ArtemisIni {
  private constructor(
    private readonly sections: ReadonlyMap<string, ReadonlyMap<string, Uint8Array>>,
  ) {}
  /** The value, or an empty string when the section or key is absent. */
  get(section: string, key: string): Uint8Array {
    const value = this.sections.get(byteName(section))?.get(byteName(key));
    return (value ?? new Uint8Array()).slice();
  }
  static parse(source: Uint8Array): ArtemisIni {
    const end = source.indexOf(0) < 0 ? source.length : source.indexOf(0);
    const at = (index: number): number => {
      if (index >= end) throw new Error('Unsupported Artemis INI text ending inside a character');
      return source[index]!;
    };
    const sections = new Map<string, Map<string, Uint8Array>>();
    let keys = new Map<string, Uint8Array>();
    let section: number[] = [],
      key: number[] = [],
      value: number[] = [];
    const store = () => {
      keys.set(latin(trim(key)), Uint8Array.from(trim(value)));
      key = [];
      value = [];
    };
    const commitSection = () => {
      sections.set(latin(section), keys);
      keys = new Map();
    };
    let state = 0;
    for (let index = 0; index < end; index++) {
      const byte = source[index]!;
      const trailing = continuationBytes(byte);
      if (state === 4) {
        if (byte & 0x80) index += trailing;
        else if (byte === 10) state = 0;
        continue;
      }
      const target = state === 1 ? section : state === 3 ? value : key;
      if (byte & 0x80) {
        target.push(byte);
        for (let n = 0; n < trailing; n++) target.push(at(++index));
        if (state === 0) state = 2;
        continue;
      }
      if (state === 0) {
        if (byte === 0x5b) {
          commitSection();
          section = [];
          state = 1;
        } else if (byte === 0x3b) state = 4;
        else if (!whitespace(byte)) {
          key.push(byte);
          state = 2;
        }
      } else if (state === 3) {
        if (byte === 10) {
          store();
          state = 0;
        } else if (byte !== 13) value.push(byte);
      } else if (byte === (state === 1 ? 0x5d : 0x3d)) state = state === 1 ? 0 : 3;
      else if (byte === 0x5c) target.push(at(++index));
      else if (byte !== 13) target.push(byte);
    }
    if (key.length) store();
    commitSection();
    return new ArtemisIni(sections);
  }
}

const whitespace = (byte: number) => byte === 9 || byte === 10 || byte === 13 || byte === 32;
/** Bytes after a UTF-8 lead byte: its high one bits after the first (0 for ASCII and for
 * continuation bytes). */
function continuationBytes(byte: number): number {
  let count = 0;
  if (byte & 0x80) for (let bit = 0x40; byte & bit; bit >>= 1) count++;
  return count;
}
/** 0x140176f30: leading whitespace bytes and a trailing whitespace run are removed. */
function trim(bytes: readonly number[]): number[] {
  const end = bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0);
  let start = 0;
  while (start < end && whitespace(bytes[start]!)) start++;
  let cut = -1;
  for (let index = start; index < end; index++) {
    const byte = bytes[index]!;
    if (byte & 0x80) {
      index += continuationBytes(byte);
      cut = -1;
    } else if (whitespace(byte)) {
      if (cut < 0) cut = index;
    } else cut = -1;
  }
  return bytes.slice(start, cut < 0 ? end : cut);
}
/** Byte strings as map keys: one character per byte. */
const latin = (bytes: readonly number[]) => String.fromCharCode(...bytes);
const byteName = (name: string) => latin([...new TextEncoder().encode(name)]);

/** MSVC `atoi` of a byte string: leading whitespace, optional sign, decimal digits;
 * saturates at int32. */
export function artemisAtoi(bytes: Uint8Array): number {
  const match = /^[\t\n\v\f\r ]*([+-]?)(\d*)/.exec(latin([...bytes]))!;
  let value = 0;
  for (const digit of match[2]!) value = Math.min(value * 10 + Number(digit), 0x80000000);
  return match[1] === '-' ? -value : Math.min(value, 0x7fffffff);
}
