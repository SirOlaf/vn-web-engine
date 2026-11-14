import {artemisRevision} from './revision.js';
import {ArtemisTextLine, type ArtemisTextLineSnapshot} from './text-line.js';
import type {ArtemisIndentation} from './text-break-controls.js';
import type {ArtemisTextBlock} from './text-block.js';

export interface ArtemisWrappingBlock<T> {
  readonly block: ArtemisTextBlock<T>;
  readonly headProhibited: boolean;
  readonly footProhibited: boolean;
  readonly opensIndent?: boolean;
  readonly closesIndent?: boolean;
  readonly text?: string;
}
export interface ArtemisWrappingStyle {
  readonly width: number;
  readonly height: number;
  readonly lineHeight: number;
  readonly align: 'left' | 'center' | 'right' | 'equalize';
  readonly hung: boolean;
}
interface Line<T> {
  geometry: ArtemisTextLine<T>;
  blocks: ArtemisWrappingBlock<T>[];
  wrapped: boolean;
  y: number;
}
export interface ArtemisWrappedLine<T> {
  readonly geometry: ArtemisTextLineSnapshot<T>;
  readonly y: number;
  readonly wrapped: boolean;
}
const f = Math.fround;
/** 195c10/195ec0/198690 wrapping and indentation storage. Glyphs and block flags
 * are supplied by the text insertion owner; this class owns line mutation and
 * paired closing/width stacks, including native placeholder blocks. */
export class ArtemisTextWrapping<T> {
  private readonly lines: Line<T>[] = [];
  private style!: ArtemisWrappingStyle;
  private hungGuard = false;
  private closed = false;
  private indentation: ArtemisIndentation = {
    pairs: new Map(),
    range: 0,
    logicalRange: false,
    nest: false,
  };
  private readonly indents: {width: number; closing: string}[] = [];
  setIndentation(value: ArtemisIndentation): void {
    this.assertOpen();
    if (!Number.isInteger(value.range) || value.range < -0x80000000 || value.range > 0x7fffffff)
      throw Error('Unsupported Artemis indent range');
    this.indentation = Object.freeze({...value, pairs: new Map(value.pairs)});
  }
  get indentClosing(): string | undefined {
    return this.indents.at(-1)?.closing;
  }
  get indentationDepth(): number {
    return this.indents.length;
  }
  /** Rev.3257 0x1401537c0: negative clears both stacks, positive pops until either is empty. */
  unindent(count: number): void {
    this.assertOpen();
    if (!Number.isInteger(count) || count < -0x80000000 || count > 0x7fffffff)
      throw Error('Invalid Artemis unindent count');
    this.indents.length = count < 0 ? 0 : Math.max(0, this.indents.length - count);
  }

  constructor(
    private readonly hash: string,
    style: ArtemisWrappingStyle,
  ) {
    artemisRevision(hash);
    this.updateStyle(style);
    this.newLine(0, false);
  }
  copy(
    copyBlock: (block: ArtemisTextBlock<T>) => ArtemisTextBlock<T> = (block) => block,
  ): ArtemisTextWrapping<T> {
    this.assertOpen();
    const copied = new ArtemisTextWrapping<T>(this.hash, this.style);
    copied.lines.length = 0;
    copied.indentation = Object.freeze({
      ...this.indentation,
      pairs: new Map(this.indentation.pairs),
    });
    copied.indents.push(...this.indents.map((indent) => ({...indent})));
    copied.hungGuard = this.hungGuard;
    for (const line of this.lines) {
      const blocks = line.blocks.map((value) =>
        Object.freeze({...value, block: copyBlock(value.block)}),
      );
      copied.lines.push({
        ...line,
        blocks,
        geometry: line.geometry.copy((_, index) => blocks[index]!.block),
      });
    }
    return copied;
  }
  /** Empty-effect branch of1962d0. Preserve indentation/configuration and hanging
   * guard; new line gets the active top placeholder. Zero count/index is a noop. */
  clear(glyphCount: number): boolean {
    this.assertOpen();
    if (!glyphCount && this.lines.length === 1) return false;
    this.lines.length = 0;
    const line = this.newLine(0, false),
      indent = this.indents.at(-1);
    if (indent) {
      const block = Object.freeze({
        width: indent.width,
        height: this.style.lineHeight,
        main: Object.freeze([]),
        ruby: Object.freeze([]),
      });
      line.geometry.append(block);
      line.blocks.push(Object.freeze({block, headProhibited: false, footProhibited: false}));
    }
    return true;
  }
  private assertOpen(): void {
    if (this.closed) throw Error('Artemis text wrapping closed');
  }
  dispose(): void {
    this.closed = true;
    this.lines.length = 0;
    this.indents.length = 0;
    this.indentation = {pairs: new Map(), range: 0, logicalRange: false, nest: false};
  }
  updateStyle(style: ArtemisWrappingStyle): void {
    this.assertOpen();
    for (const value of [style.width, style.height, style.lineHeight])
      if (!Number.isFinite(value) || !Number.isFinite(f(value)) || value < 0)
        throw Error('Unsupported Artemis wrapping geometry');
    if (!['left', 'center', 'right', 'equalize'].includes(style.align))
      throw Error('Unsupported Artemis wrapping alignment');
    this.style = Object.freeze({
      ...style,
      width: f(style.width),
      height: f(style.height),
      lineHeight: f(style.lineHeight),
    });
  }
  append(value: ArtemisWrappingBlock<T>): 'ok' | 'unprintable' | 'overflow' {
    this.assertOpen();
    if (!Number.isFinite(value.block.width) || !Number.isFinite(value.block.height))
      throw Error('Unsupported Artemis wrapping block');
    if (f(value.block.width) > this.style.width) return 'unprintable';
    const snapshot = Object.freeze({...value});
    if (this.insert(snapshot, 0)) return 'overflow';
    this.applyIndent(snapshot);
    return 'ok';
  }
  /** Native explicit newline has no immediate vertical-overflow check. */
  newline(omitBlank = false): boolean {
    this.assertOpen();
    const line = this.lines.at(-1)!;
    if (
      omitBlank &&
      (!line.blocks.length ||
        (line.blocks.length === 1 &&
          !line.blocks[0]!.block.main.length &&
          !line.blocks[0]!.block.ruby.length))
    ) {
      line.wrapped = false;
      return false;
    }
    this.advance(false);
    return true;
  }
  private newLine(y: number, wrapped: boolean): Line<T> {
    if (this.lines.length >= 10000) throw Error('Artemis wrapping line budget exceeded');
    const line = {geometry: new ArtemisTextLine<T>(this.hash), blocks: [], wrapped, y};
    this.lines.push(line);
    return line;
  }
  private finalizeLine(line: Line<T>): ArtemisTextLineSnapshot<T> {
    return line.geometry.finalize(this.style.width, this.style.align, this.style.lineHeight);
  }
  private applyIndent(value: ArtemisWrappingBlock<T>): void {
    if (value.opensIndent) {
      if (this.indents.length && !this.indentation.nest) return;
      let index = this.lines.length - 1,
        count = this.lines[index]!.geometry.characterCount;
      if (this.indentation.logicalRange)
        while (index > 0 && this.lines[index]!.wrapped) {
          index--;
          count = (count + this.lines[index]!.geometry.characterCount) | 0;
        }
      if (this.indentation.range && count > this.indentation.range) return;
      const closing = value.text === undefined ? undefined : this.indentation.pairs.get(value.text);
      if (closing === undefined) throw Error('Unsupported Artemis indent opener flag');
      if (this.indents.length >= 1024) throw Error('Artemis indent stack budget exceeded');
      this.indents.push({width: this.lines.at(-1)!.geometry.width, closing});
    } else if (value.closesIndent) {
      if (!this.indents.length) throw Error('Unsupported Artemis indent stack underflow');
      this.indents.pop();
    }
  }
  private advance(wrapped: boolean, next?: ArtemisWrappingBlock<T>): void {
    const line = this.lines[this.lines.length - 1]!;
    const height = this.finalizeLine(line).height;
    const created = this.newLine(f(line.y + height), wrapped),
      indent = this.indents.at(-1);
    if (indent) {
      if (wrapped && next && f(f(next.block.width) + indent.width) > this.style.width) {
        // Pop only one level and do not insert an underlying level's placeholder.
        this.indents.pop();
      } else {
        const block = Object.freeze({
          width: indent.width,
          height: this.style.lineHeight,
          main: Object.freeze([]),
          ruby: Object.freeze([]),
        });
        const placeholder = Object.freeze({block, headProhibited: false, footProhibited: false});
        created.geometry.append(block);
        created.blocks.push(placeholder);
      }
    }
  }
  private pop(line: Line<T>): ArtemisWrappingBlock<T> {
    line.geometry.pop();
    return line.blocks.pop()!;
  }
  private insert(value: ArtemisWrappingBlock<T>, depth: number): boolean {
    if (depth > 1024) throw Error('Artemis wrapping recursion budget exceeded');
    let line = this.lines[this.lines.length - 1]!;
    if (f(line.geometry.width + f(value.block.width)) <= this.style.width) {
      if (f(line.y + f(value.block.height)) > this.style.height) return true;
      // A prohibited head on any empty noninitial line pulls the previous last block.
      if (
        this.lines.length > 1 &&
        value.headProhibited &&
        (!line.blocks.length ||
          (line.blocks.length === 1 &&
            !line.blocks[0]!.block.main.length &&
            !line.blocks[0]!.block.ruby.length))
      ) {
        const previous = this.lines[this.lines.length - 2]!;
        if (previous.blocks.length > 1) {
          this.hungGuard = true;
          this.insert(this.pop(previous), depth + 1);
          this.finalizeLine(previous);
          return this.insert(value, depth + 1);
        }
      }
      this.hungGuard = false;
    } else if (
      !value.headProhibited ||
      !this.style.hung ||
      this.hungGuard ||
      line.geometry.width > this.style.width
    ) {
      const moved: ArtemisWrappingBlock<T>[] = [];
      while (line.blocks.length > 1 && line.blocks.at(-1)!.footProhibited)
        moved.unshift(this.pop(line));
      this.advance(true, value);
      for (const block of moved) this.insert(block, depth + 1);
      return this.insert(value, depth + 1);
    }
    // Native hanging punctuation bypasses the fitting branch's vertical check.
    line = this.lines[this.lines.length - 1]!;
    line.geometry.append(value.block);
    line.blocks.push(value);
    return false;
  }
  /** 149d90/149e60/149ea0 report insertion metrics, not frame bounding boxes. */
  measure(): {readonly width: number; readonly height: number; readonly lineWidth: number} {
    this.assertOpen();
    let width = 0;
    for (const line of this.lines) if (line.geometry.width > width) width = line.geometry.width;
    const current = this.lines.at(-1)!;
    return Object.freeze({
      width,
      height: f(current.y + (current.geometry.characterCount ? current.geometry.height : 0)),
      lineWidth: current.geometry.width,
    });
  }
  /** Native14c5d0 finalizes only a nonempty current line, then computes frame row
   * positions from stored heights. Cached insertion Y is deliberately retained. */
  prepareFrame(): readonly ArtemisWrappedLine<T>[] {
    this.assertOpen();
    const current = this.lines.at(-1)!;
    if (current.blocks.length) this.finalizeLine(current);
    let y = 0;
    return Object.freeze(
      this.lines.map((line) => {
        const geometry = line.geometry.snapshot(),
          positioned = Object.freeze({geometry, y, wrapped: line.wrapped});
        y = f(y + geometry.height);
        return positioned;
      }),
    );
  }
  finalize(): readonly ArtemisWrappedLine<T>[] {
    this.assertOpen();
    return Object.freeze(
      this.lines.map((line) =>
        Object.freeze({geometry: this.finalizeLine(line), y: line.y, wrapped: line.wrapped}),
      ),
    );
  }
}

/** Compatibility facade for callers that intentionally require no indentation. */
export class ArtemisUnindentedTextWrapping<T> extends ArtemisTextWrapping<T> {
  override setIndentation(value: ArtemisIndentation): void {
    if (value.pairs.size) throw Error('Unsupported Artemis active indentation insertion');
    super.setIndentation(value);
  }
}
