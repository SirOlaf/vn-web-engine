import {artemisDefaultFontAttributes, type ArtemisFontAttributes} from './font-state.js';
import {artemisRevision} from './revision.js';
import {layoutArtemisTextBlock, type ArtemisTextBlock} from './text-block.js';
import {artemisUtf8TextBlockFlags} from './text-block-flags.js';
import {artemisUtf8TextRuns} from './text-runs.js';
import {artemisUtf8Prohibition, type ArtemisIndentation} from './text-break-controls.js';
import {ArtemisTextWrapping, type ArtemisWrappedLine} from './text-wrapping.js';
import type {ArtemisTextGlyphResource, ArtemisTextGlyphStyle} from './text-glyphs.js';
import type {ArtemisPrintResult} from './print.js';

export interface ArtemisInsertionStyle
  extends ArtemisTextGlyphStyle, Partial<Omit<ArtemisFontAttributes, keyof ArtemisTextGlyphStyle>> {
  readonly width: number;
  readonly height: number;
  readonly align: 'left' | 'center' | 'right' | 'equalize';
  readonly hung: boolean;
  readonly vertical: boolean;
}
export interface ArtemisTextInsertionHost {
  /** Must create actual font/glyph resources, not estimate widths. */
  loadBlock(
    main: string,
    ruby: string,
    style: ArtemisTextGlyphStyle,
  ): Promise<ArtemisTextBlock<ArtemisTextGlyphResource>>;
  /** Frame owner retains these blocks/resources and applies actual display effects. */
  publishFrame(frame: ArtemisTextInsertionFrame): Promise<void>;
}
export interface ArtemisInsertionGlyphResource extends ArtemisTextGlyphResource {
  readonly glyphId: number;
  readonly font: ArtemisFontAttributes;
}
export interface ArtemisTextInsertionFrame {
  readonly glyphCount: number;
  readonly font: ArtemisFontAttributes;
  readonly lines: readonly ArtemisWrappedLine<ArtemisInsertionGlyphResource>[];
}
/** UTF-8 195720/195c10 insertion including indentation stacks. It owns logical layout
 * and consumed offsets, while the required host owns actual glyphs and published
 * frames. Scene attachment, animation and vertical display rotation are separate.
 */
export class ArtemisTextInsertion {
  private style: ArtemisFontAttributes;
  private wrapping: ArtemisTextWrapping<ArtemisInsertionGlyphResource>;
  private head = new Set<string>();
  private foot = new Set<string>();
  private wordparts = new Set<string>();
  private indentPairs = new Map<string, string>();
  private afterNewline = false;
  private count = 0;
  private generation = 0;
  private pending = false;
  private publishing = false;
  private closed = false;
  constructor(
    private readonly hash: string,
    style: ArtemisInsertionStyle,
    private readonly host: ArtemisTextInsertionHost,
  ) {
    artemisRevision(hash);
    this.style = this.validateStyle(style);
    this.wrapping = new ArtemisTextWrapping(hash, this.wrappingStyle(this.style));
    this.setProhibitedCharacters(new Set(), new Set());
  }
  /** Copies this logical insertion owner. The enclosing CLinkableTextLayer owner
   * separately owns display state, in/out job handles and the native link-scope move. */
  copy(host: ArtemisTextInsertionHost): ArtemisTextInsertion {
    this.idle();
    const copied = new ArtemisTextInsertion(this.hash, this.style, host);
    copied.wrapping.dispose();
    const clone = (
      stream: readonly {
        glyph: ArtemisInsertionGlyphResource;
        advance: number;
        x: number;
        y: number;
      }[],
    ) =>
      Object.freeze(
        stream.map((value) => Object.freeze({...value, glyph: Object.freeze({...value.glyph})})),
      );
    copied.wrapping = this.wrapping.copy((block) =>
      Object.freeze({...block, main: clone(block.main), ruby: clone(block.ruby)}),
    );
    copied.head = new Set(this.head);
    copied.foot = new Set(this.foot);
    copied.wordparts = new Set(this.wordparts);
    copied.indentPairs = new Map(this.indentPairs);
    copied.afterNewline = this.afterNewline;
    copied.count = this.count;
    return copied;
  }
  private validateStyle(style: ArtemisInsertionStyle): ArtemisFontAttributes {
    const font = {...artemisDefaultFontAttributes(this.hash), ...style};
    if (font.vertical) throw Error('Unsupported Artemis vertical text insertion');
    for (const key of [
      'left',
      'top',
      'entireanchorx',
      'entireanchory',
      'entirealpha',
      'entirexscale',
      'entireyscale',
      'entirerotate',
      'alpha',
      'xscale',
      'yscale',
      'rotate',
      'width',
      'height',
      'spacetop',
      'spacemiddle',
      'spacebottom',
      'kerning',
      'rubykerning',
    ] as const) {
      if (!Number.isFinite(font[key]) || !Number.isFinite(Math.fround(font[key])))
        throw Error('Unsupported Artemis font display property');
      font[key] = Math.fround(font[key]);
    }
    layoutArtemisTextBlock(this.hash, [], [], font);
    for (const key of ['face', 'rubyface'] as const)
      if (typeof font[key] !== 'string') {
        const bytes = font[key] as readonly number[];
        if (bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255))
          throw Error('Unsupported Artemis font face bytes');
        font[key] = Object.freeze([...bytes]);
      }
    return Object.freeze(font);
  }
  private wrappingStyle(style: ArtemisInsertionStyle) {
    return {
      width: style.width,
      height: style.height,
      align: style.align,
      hung: style.hung,
      lineHeight: layoutArtemisTextBlock(this.hash, [], [], style).height,
    };
  }
  private idle(): void {
    if (this.closed) throw Error('Artemis text insertion closed');
    if (this.pending || this.publishing) throw Error('Overlapping Artemis text insertion effects');
  }
  setStyle(style: ArtemisInsertionStyle): void {
    this.idle();
    const next = this.validateStyle(style);
    this.wrapping.updateStyle(this.wrappingStyle(next));
    this.style = next;
  }
  setIndentation(value: ArtemisIndentation): void {
    this.idle();
    this.wrapping.setIndentation(value);
    this.indentPairs = new Map(value.pairs);
  }
  unindent(count: number): void {
    this.idle();
    this.wrapping.unindent(count);
  }
  get indentationDepth(): number {
    this.idle();
    return this.wrapping.indentationDepth;
  }
  setProhibitedCharacters(head: ReadonlySet<string>, foot: ReadonlySet<string>): void {
    this.idle();
    const next = artemisUtf8Prohibition(head, foot);
    this.head = next.head;
    this.foot = next.foot;
  }
  setWordParts(parts: ReadonlySet<string>): void {
    this.idle();
    artemisUtf8TextRuns(this.hash, '', [...parts]);
    this.wordparts = new Set(parts);
  }
  /** Enclosing owner must actually cancel incoming/previous outgoing jobs and
   * select an empty outgoing descriptor vector before invoking this branch. */
  clearEmptyEffects(): boolean {
    this.idle();
    if (!this.wrapping.clear(this.count)) return false;
    this.count = 0;
    return true;
  }
  /** Lines (+0x528) and their blocks for the display owner, after the frame layout. */
  displayBlocks(): readonly (readonly ArtemisTextBlock<ArtemisInsertionGlyphResource>[])[] {
    return this.displayLines().map((line) =>
      line.geometry.blocks.map((positioned) => positioned.block),
    );
  }
  /** The display lines with their row Y and positioned blocks (14c5d0 without publishing). */
  displayLines(): readonly ArtemisWrappedLine<ArtemisInsertionGlyphResource>[] {
    this.idle();
    return this.wrapping.prepareFrame();
  }
  snapshotFont(): ArtemisFontAttributes {
    this.idle();
    return this.style;
  }
  measure(): {readonly width: number; readonly height: number; readonly lineWidth: number} {
    this.idle();
    return this.wrapping.measure();
  }
  get glyphCount(): number {
    return this.count;
  }
  /** An insertion or published frame is in progress; layout reads wait for its end. */
  get busy(): boolean {
    return this.pending || this.publishing;
  }
  async insert(input: Uint8Array): Promise<ArtemisPrintResult> {
    this.idle();
    const bytes = Uint8Array.from(input),
      nul = bytes.indexOf(0);
    const data = nul < 0 ? bytes : bytes.subarray(0, nul);
    const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(data);
    const runs = artemisUtf8TextRuns(this.hash, text, [...this.wordparts]);
    this.pending = true;
    const generation = this.generation,
      style = this.style;
    try {
      for (const run of runs) {
        if (run.text[0] === '\n') {
          // Native checks the first byte; a wordparts run starting with LF is
          // consumed as one newline even if its remaining characters are grouped.
          this.wrapping.newline();
          this.afterNewline = true;
          continue;
        }
        const result = await this.appendBlock(run.text, '', generation, style);
        if (result === -1 || result === -2)
          return Object.freeze({result, consumedBytes: run.utf8Start});
      }
      return Object.freeze({result: this.count, consumedBytes: data.byteLength});
    } finally {
      if (generation === this.generation) this.pending = false;
    }
  }
  private async appendBlock(
    main: string,
    ruby: string,
    generation: number,
    style: ArtemisFontAttributes,
  ): Promise<number> {
    const loaded = await this.host.loadBlock(main, ruby, style);
    if (this.closed || generation !== this.generation)
      throw Error('Artemis text insertion cancelled');
    const flags = artemisUtf8TextBlockFlags(this.hash, main, {
      head: this.head,
      foot: this.foot,
      indentPairs: this.indentPairs,
      indentClosing: this.wrapping.indentClosing,
      afterExplicitNewline: this.afterNewline,
    });
    this.afterNewline = false;
    const saved = this.count;
    // Native constructs new logical glyphs even when cached pixels are reused.
    // Counter520 includes both streams; line90 counts only main glyphs.
    const indexed = (stream: typeof loaded.main) =>
      Object.freeze(
        stream.map((glyph) => {
          const resource = Object.freeze({...glyph.glyph, glyphId: this.count, font: style});
          this.count = (this.count + 1) | 0;
          return Object.freeze({...glyph, glyph: resource});
        }),
      );
    const block = Object.freeze({
      ...loaded,
      main: indexed(loaded.main),
      ruby: indexed(loaded.ruby),
    });
    const result = this.wrapping.append({block, text: main, ...flags});
    if (result !== 'ok') {
      this.count = saved;
      return result === 'overflow' ? -2 : -1;
    }
    return this.count;
  }
  newline(omitBlank = false): void {
    this.idle();
    if (this.wrapping.newline(omitBlank)) this.afterNewline = true;
  }
  /** Direct195c10 insertion used by /ruby. Grouping is bypassed; only leading LF
   * is interpreted as newline. Both streams belong to one atomic logical block. */
  async insertRuby(main: Uint8Array, ruby: Uint8Array): Promise<number> {
    this.idle();
    const decode = (bytes: Uint8Array) => {
      const copy = Uint8Array.from(bytes),
        nul = copy.indexOf(0);
      return new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(
        nul < 0 ? copy : copy.subarray(0, nul),
      );
    };
    const text = decode(main),
      annotation = decode(ruby);
    if (text.startsWith('\n')) {
      this.newline();
      return this.count;
    }
    this.pending = true;
    const generation = this.generation;
    try {
      return await this.appendBlock(text, annotation, generation, this.style);
    } finally {
      if (generation === this.generation) this.pending = false;
    }
  }
  async prepareFrame(): Promise<ArtemisTextInsertionFrame> {
    this.idle();
    const lines = this.wrapping.prepareFrame();
    if (this.style.anchorcenter) {
      let width = 0,
        height = 0;
      for (const line of lines) {
        width = Math.max(width, line.geometry.width);
        height = Math.fround(height + line.geometry.height);
      }
      const entireanchorx =
        this.style.align === 'left'
          ? Math.fround(width * 0.5)
          : this.style.align === 'right'
            ? Math.fround(Math.fround(this.style.width) - Math.fround(width * 0.5))
            : Math.fround(Math.fround(this.style.width) * 0.5);
      this.style = Object.freeze({
        ...this.style,
        entireanchorx,
        entireanchory: Math.fround(height * 0.5),
      });
    }
    const frame = Object.freeze({glyphCount: this.count, font: this.style, lines});
    this.publishing = true;
    try {
      await this.host.publishFrame(frame);
      return frame;
    } finally {
      this.publishing = false;
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.pending = false;
    this.wrapping.dispose();
  }
}
