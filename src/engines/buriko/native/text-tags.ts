import {pointerView, type BurikoBpPointer} from '../bp/memory.js';
import {BurikoNativeText, copyText, textByte} from './text.js';

const pointer = (text: string): BurikoBpPointer => ({
  bytes: Uint8Array.from([...text].map((unit) => unit.charCodeAt(0)).concat(0)),
  offset: 0,
});
const lowerOpen = pointer('<l>'),
  upperOpen = pointer('<L>'),
  lowerClose = pointer('</l>'),
  upperClose = pointer('</L>'),
  open = pointer('<'),
  close = pointer('>');
const at = (source: BurikoBpPointer, offset: number): BurikoBpPointer => ({
  bytes: source.bytes,
  offset,
});
function move(destination: BurikoBpPointer, source: BurikoBpPointer, length: number): void {
  if (length === 0) return;
  const input = pointerView(source, length),
    output = pointerView(destination, length);
  // TypedArray.set retains memmove overlap behavior on shared native backing.
  new Uint8Array(output.buffer, output.byteOffset, length).set(
    new Uint8Array(input.buffer, input.byteOffset, length),
  );
}

/**073700: lowercase searches take priority even when an uppercase match occurs earlier. */
export function collectBurikoRawLinks(
  text: BurikoNativeText,
  output: BurikoBpPointer | null,
  source: BurikoBpPointer | null,
): number {
  if (source === null) throw new Error('Buriko raw link encoding detection reads null source');
  const mode = text.detectEncoding(source.bytes, source.offset, false);
  let cursor = source.offset,
    count = 0;
  const find = (start: number, needle: BurikoBpPointer): number | null => {
    const found = text.find(at(source, start), needle, mode);
    return found === null ? null : start + found;
  };
  for (;;) {
    const begin = find(cursor, lowerOpen) ?? find(cursor, upperOpen);
    if (begin === null) return count;
    const content = begin + 3,
      end = find(content, lowerClose) ?? find(content, upperClose);
    if (end === null) return count;
    const length = (end - content) >>> 0;
    if (length !== 0) {
      if (output !== null) {
        const destination = at(output, output.offset + count * 128),
          view = pointerView(destination, 128);
        new Uint8Array(view.buffer, view.byteOffset, 128).fill(0);
        move(destination, at(source, content), Math.min(length, 95));
      }
      count = (count + 1) >>> 0;
    }
    cursor = end + 3;
  }
}

/**073530 searches closing '>' from the current source+2, not the found opening+2. */
export function stripBurikoTextTags(
  text: BurikoNativeText,
  output: BurikoBpPointer | null,
  source: BurikoBpPointer | null,
): void {
  if (source === null) throw new Error('Buriko tag-strip encoding detection reads null source');
  const mode = text.detectEncoding(source.bytes, source.offset, false);
  let cursor = source.offset,
    destination = output?.offset ?? 0;
  const target = (): BurikoBpPointer => {
    if (output === null) throw new Error('Buriko tag stripping writes through null');
    return at(output, destination);
  };
  for (;;) {
    const found = text.find(at(source, cursor), open, mode);
    if (found === null) break;
    const next = textByte(source.bytes, cursor + found + 1);
    if ((next >= 65 && next <= 90) || (next >= 97 && next <= 122) || next === 47) {
      const end = text.find(at(source, cursor + 2), close, mode);
      if (end === null) break;
      if (found !== 0) move(target(), at(source, cursor), found);
      destination += found;
      cursor = cursor + 2 + end + 1;
    } else {
      const byte = textByte(source.bytes, cursor);
      pointerView(target(), 1).setUint8(0, byte);
      destination++;
      cursor++;
    }
  }
  copyText(target(), at(source, cursor));
}
