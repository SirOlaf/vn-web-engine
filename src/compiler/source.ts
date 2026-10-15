/**
 * A source text with its line table. Lines are numbered from 1 plus `lineOffset` (a script
 * embedded in another file starts at that file's line); columns count UTF-16 code units from 0.
 */
export class SourceText {
  readonly #lineStarts: number[] = [0];

  constructor(
    readonly name: string,
    readonly text: string,
    readonly lineOffset = 0,
  ) {
    for (let i = 0; i < text.length; i++)
      if (text.charCodeAt(i) === 0x0a) this.#lineStarts.push(i + 1);
  }

  get lineCount(): number {
    return this.#lineStarts.length;
  }

  /** Line (from 1 + lineOffset) of the character at `offset`. */
  line(offset: number): number {
    return this.#lineIndex(offset) + 1 + this.lineOffset;
  }

  column(offset: number): number {
    return offset - this.#lineStarts[this.#lineIndex(offset)]!;
  }

  #lineIndex(offset: number): number {
    const starts = this.#lineStarts;
    let lo = 0,
      hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

/** Converts CR LF and lone CR line breaks to LF. Line numbers are unchanged. */
export function normalizeLineBreaks(text: string): string {
  return text.indexOf('\r') < 0 ? text : text.replace(/\r\n?/g, '\n');
}
