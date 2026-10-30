import {artemisRevision} from './revision.js';

export interface ArtemisTextRun {
  readonly text: string;
  readonly utf8Start: number;
  readonly utf8End: number;
}
/** UTF-8 branch of195720: ASCII letters form runs by default; an explicit
 * wordparts set groups adjacent members instead. Native scratch buffer holds
 * 1023 bytes plus NUL. Refuse its partial-multibyte boundary rather than changing
 * the native bytes into a different valid string. No wrapping is performed here.
 */
export function artemisUtf8TextRuns(
  hash: string,
  text: string,
  wordparts: readonly string[] = [],
): readonly ArtemisTextRun[] {
  artemisRevision(hash);
  const encoder = new TextEncoder(),
    decoder = new TextDecoder('utf-8', {ignoreBOM: true});
  text = text.split('\0', 1)[0]!;
  if (decoder.decode(encoder.encode(text)) !== text) throw Error('Unsupported Artemis run UTF-8');
  if (text.length > 1000000) throw Error('Artemis text run budget exceeded');
  const members = new Set(wordparts);
  for (const value of members)
    if (
      Array.from(value).length !== 1 ||
      value === '\0' ||
      decoder.decode(encoder.encode(value)) !== value
    )
      throw Error('Unsupported Artemis wordparts character');
  const symbols = Array.from(text),
    output: ArtemisTextRun[] = [];
  const grouped = members.size
    ? (symbol: string) => members.has(symbol)
    : (symbol: string) => /^[A-Za-z]$/.test(symbol);
  let index = 0,
    offset = 0;
  while (index < symbols.length) {
    const start = index,
      byteStart = offset,
      first = symbols[index]!;
    const isRun = grouped(first);
    let bytes = 0;
    do {
      const symbol = symbols[index]!;
      const length = encoder.encode(symbol).byteLength;
      if (bytes + length > 1023)
        throw Error('Unsupported Artemis partial UTF-8 wordparts buffer boundary');
      bytes += length;
      index++;
    } while (isRun && bytes < 1023 && index < symbols.length && grouped(symbols[index]!));
    offset += bytes;
    output.push(
      Object.freeze({
        text: symbols.slice(start, index).join(''),
        utf8Start: byteStart,
        utf8End: offset,
      }),
    );
    if (output.length > 10000) throw Error('Artemis text run budget exceeded');
  }
  return Object.freeze(output);
}
