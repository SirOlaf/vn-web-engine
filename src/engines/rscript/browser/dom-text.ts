import {
  domTextClasses,
  domTextFamily,
  getDomTextStyle,
  subscribeDomTextStyle,
  type DomTextStyle,
} from '../../../text/dom-text-style.js';
import {objectFitPlacement} from '../../../graphics/object-fit.js';
import {RScriptContainer, type BakedGlyph, type RScriptNode} from '../graphics/sprite.js';
import {RScriptTextBlock} from '../runtime/text-block.js';

export interface RScriptDomTextOptions {
  readonly document: Document;
  /** The element the layer is placed in; it must be positioned. */
  readonly parent: HTMLElement;
  /** The game canvas the layer lines up with. */
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  /** CSS font families of a glyph face, so selections cover the glyphs. */
  families(face: number): string;
  /** Stops the canvas drawing text while styled browser text presents it. */
  hideText(hidden: boolean): void;
  /** Input over the text that belongs to the game. */
  wheel(up: boolean): void;
  cancel(): void;
}

interface BlockView {
  readonly element: HTMLElement;
  signature: string;
  /** Glyph elements by glyph index, for reveal fades; empty for transparent text. */
  spans: HTMLElement[];
}

const STYLE_ID = 'rscript-dom-text-style';
const STYLE = `
.rscript-dom-text { position: absolute; left: 0; top: 0; transform-origin: 0 0;
  overflow: hidden; pointer-events: none; }
.rscript-dom-text > div { position: absolute; }
.rscript-dom-text [data-line] { position: absolute; white-space: nowrap;
  pointer-events: auto; cursor: text; }
.rscript-dom-text:not([data-styled]) [data-line] { color: transparent; }
.rscript-dom-text:not([data-styled]) [data-line] > span { display: inline-block;
  vertical-align: bottom; }
.rscript-dom-text:not([data-styled]) ::selection { background: rgb(64 128 255 / 40%);
  color: transparent; }
.rscript-dom-text rt { user-select: none; }
`;

/**
 * Selectable text over the game canvas for copying and dictionary extensions, placed over
 * each visible text object (message boxes, the backlog pages they show, choices and screen
 * text). Without a custom style the native glyphs stay on the canvas and transparent
 * browser text covers them, one span per glyph cell so selections line up with the native
 * layout. With the reader's custom style (see dom-text-style.ts) the browser text is
 * visible in the chosen font, size and weight, with ruby, and the canvas draws no text.
 */
export class RScriptDomText {
  readonly element: HTMLElement;
  private readonly blocks = new Map<RScriptNode, BlockView>();
  private readonly resize: ResizeObserver;
  /** Re-reads canvas placement; box resizes are observed, `object-fit` changes are not. */
  readonly relayout: () => void;
  private readonly unsubscribeStyle: () => void;
  private enabled = false;
  private styled = false;
  private frame = 0;
  private root: RScriptContainer | null = null;

  constructor(private readonly options: RScriptDomTextOptions) {
    const {document, parent, canvas, width, height} = options;
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = STYLE;
      document.head.append(style);
    }
    this.element = document.createElement('div');
    // game-glyph-slots scopes the reader stylesheet (domTextStylesheet).
    this.element.className = 'rscript-dom-text game-glyph-slots';
    this.element.style.width = `${width}px`;
    this.element.style.height = `${height}px`;
    this.element.hidden = true;
    parent.append(this.element);
    const fit = (): void => {
      const r = canvas.getBoundingClientRect(),
        p = parent.getBoundingClientRect();
      const {scaleX, scaleY, offsetX, offsetY} = objectFitPlacement(canvas, r, width, height);
      Object.assign(this.element.style, {
        left: `${r.left - p.left + offsetX}px`,
        top: `${r.top - p.top + offsetY}px`,
        transform: scaleX === scaleY ? `scale(${scaleX || 1})` : `scale(${scaleX}, ${scaleY})`,
      });
    };
    this.relayout = fit;
    this.resize = new ResizeObserver(fit);
    this.resize.observe(canvas);
    fit();
    this.unsubscribeStyle = subscribeDomTextStyle(() => this.restyle());
    this.element.addEventListener('copy', (event) => this.copy(event));
    this.element.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        if (event.deltaY) options.wheel(event.deltaY < 0);
      },
      {passive: false},
    );
    // The browser menu stays available for copying a selection.
    this.element.addEventListener('contextmenu', (event) => {
      if (this.selected) return;
      event.preventDefault();
      options.cancel();
    });
  }

  /** Text is selected inside the layer. */
  get selected(): boolean {
    const selection = this.options.document.getSelection();
    return (
      !!selection &&
      !selection.isCollapsed &&
      !!selection.anchorNode &&
      this.element.contains(selection.anchorNode)
    );
  }

  setEnabled(enabled: boolean, root: RScriptContainer): void {
    this.enabled = enabled;
    this.root = root;
    this.element.hidden = !enabled;
    if (!enabled) this.clear();
    this.restyle();
  }

  /** Applies the reader's style: every block is rebuilt and the canvas text follows. */
  private restyle(): void {
    this.styled = this.enabled && getDomTextStyle().enabled;
    this.element.toggleAttribute('data-styled', this.styled);
    this.options.hideText(this.styled);
    for (const view of this.blocks.values()) view.signature = '';
    this.update();
  }

  /** Coalesces updates to one per animation frame after the game presents. */
  schedule(): void {
    if (!this.enabled || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.update();
    });
  }

  update(): void {
    if (!this.enabled || !this.root) return;
    const found: RScriptNode[] = [];
    collect(this.root, found);
    const keep = new Set<RScriptNode>();
    let order = 0;
    for (const block of found) {
      const glyphs = block instanceof RScriptTextBlock ? block.shownGlyphs() : block.bakedText!;
      if (!glyphs.length) continue;
      keep.add(block);
      const at = block.screenPosition();
      const signature =
        `${at.x},${at.y},${block.width},${block.height}|` +
        glyphs
          .map(
            (g) =>
              `${g.text}${g.x},${g.y},${g.width},${g.height},${g.color},${g.face},` +
              `${+g.bold}${+g.italic}${+g.newline}${g.ruby ? `[${g.ruby.text}${g.ruby.span}]` : ''}`,
          )
          .join(';');
      let view = this.blocks.get(block);
      if (!view) {
        view = {element: this.options.document.createElement('div'), signature: '', spans: []};
        this.blocks.set(block, view);
      }
      view.element.style.left = `${at.x}px`;
      view.element.style.top = `${at.y}px`;
      view.element.style.zIndex = String(order);
      if (this.element.children[order] !== view.element)
        this.element.insertBefore(view.element, this.element.children[order] ?? null);
      // Rebuilding only on change keeps a selection while the text stays the same.
      if (view.signature !== signature) {
        view.signature = signature;
        if (this.styled) this.renderStyled(view, glyphs, block);
        else this.render(view, glyphs);
      }
      // Glyphs fade in as they are revealed.
      view.spans.forEach((span, i) => {
        const opacity = String(glyphs[i]?.opacity ?? 1);
        if (span.style.opacity !== opacity) span.style.opacity = opacity;
      });
      order++;
    }
    for (const [block, view] of this.blocks)
      if (!keep.has(block)) {
        view.element.remove();
        this.blocks.delete(block);
      }
  }

  /**
   * Lines of glyphs: a row shares a bottom edge (0x45AF80 aligns them to the line height), a
   * column of vertical text a left edge.
   */
  private rows(glyphs: readonly BakedGlyph[]): BakedGlyph[][] {
    const rows: BakedGlyph[][] = [];
    for (const glyph of glyphs) {
      const row = rows.at(-1);
      const first = row?.[0];
      const same =
        first &&
        !glyph.newline &&
        (glyph.vertical ? first.x === glyph.x : first.y + first.height === glyph.y + glyph.height);
      if (same) row.push(glyph);
      else rows.push([glyph]);
    }
    return rows;
  }

  /** Transparent cells over the native glyphs. */
  private render(view: BlockView, glyphs: readonly BakedGlyph[]): void {
    const {document, families} = this.options;
    const {element} = view;
    element.replaceChildren();
    element.style.width = element.style.height = element.style.overflow = '';
    view.spans = [];
    this.rows(glyphs).forEach((row, index) => {
      const line = document.createElement('div');
      line.dataset.line = '';
      // Explicit breaks copy as newlines; the layout's own wraps do not.
      if (index === 0 || row[0]!.newline) line.dataset.break = '';
      if (row[0]!.vertical) {
        const width = Math.max(...row.map((g) => g.width));
        Object.assign(line.style, {
          left: `${row[0]!.x}px`,
          top: `${row[0]!.y}px`,
          width: `${width}px`,
          lineHeight: `${width}px`,
          writingMode: 'vertical-rl',
          fontFamily: families(row[0]!.face),
        });
        row.forEach((glyph, i) => {
          const span = document.createElement('span');
          span.textContent = glyph.text;
          const next = row[i + 1];
          span.style.height = `${next ? next.y - glyph.y : glyph.height}px`;
          span.style.fontSize = `${glyph.width}px`;
          line.append(span);
        });
        element.append(line);
        return;
      }
      const top = Math.min(...row.map((g) => g.y));
      const height = Math.max(...row.map((g) => g.y + g.height)) - top;
      Object.assign(line.style, {
        left: `${row[0]!.x}px`,
        top: `${top}px`,
        height: `${height}px`,
        lineHeight: `${height}px`,
        fontFamily: families(row[0]!.face),
      });
      row.forEach((glyph, i) => {
        const span = document.createElement('span');
        span.textContent = glyph.text;
        const next = row[i + 1];
        span.style.width = `${next ? next.x - glyph.x : glyph.width}px`;
        span.style.fontSize = `${glyph.height}px`;
        line.append(span);
      });
      element.append(line);
    });
  }

  /**
   * Visible text in the reader's style. `fit` keeps the native rows, compressed to their
   * native width and clipped to the text object; `natural` flows the text through the
   * object's width with the font's own advances and a line height that fits it.
   */
  private renderStyled(view: BlockView, glyphs: readonly BakedGlyph[], block: RScriptNode): void {
    const {document} = this.options;
    const style = getDomTextStyle();
    const natural = style.layout === 'natural';
    const {element} = view;
    element.replaceChildren();
    element.style.width = `${block.width}px`;
    element.style.height = `${block.height}px`;
    element.style.overflow = natural ? 'visible' : 'hidden';
    view.spans = [];
    const rows = this.rows(glyphs);
    if (glyphs[0]!.vertical) {
      this.renderStyledColumns(view, rows, glyphs, block, style);
      return;
    }
    const size = Math.max(...glyphs.map((g) => g.height));
    const classes = [
      domTextClasses.text,
      domTextClasses.horizontal,
      ...(rows.length > 1 ? [domTextClasses.multiline] : []),
    ].join(' ');
    const line = (): HTMLElement => {
      const text = document.createElement('div');
      text.dataset.line = '';
      text.className = classes;
      text.lang = 'ja';
      text.dataset.fontSize = String(size);
      return text;
    };
    const tops = rows.map((row) => Math.min(...row.map((g) => g.y)));
    if (natural) {
      const text = line();
      text.dataset.break = '';
      const left = rows[0]![0]!.x;
      const pitch = rows.length > 1 ? tops[1]! - tops[0]! : size;
      Object.assign(text.style, {
        left: `${left}px`,
        top: `${tops[0]}px`,
        width: `${Math.max(size, block.width - left)}px`,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        lineHeight: `${Math.max(pitch, size * style.scale * 1.25)}px`,
        fontSize: `${size * style.scale}px`,
      });
      rows.forEach((row, index) => {
        // Only the script's breaks remain; the text wraps at the object's edge.
        if (index > 0 && row[0]!.newline) text.append('\n');
        this.appendGlyphs(text, row, glyphs, style, view.spans);
      });
      element.append(text);
      return;
    }
    rows.forEach((row, index) => {
      const text = line();
      if (index === 0 || row[0]!.newline) text.dataset.break = '';
      const height = Math.max(...row.map((g) => g.y + g.height)) - tops[index]!;
      Object.assign(text.style, {
        left: `${row[0]!.x}px`,
        top: `${tops[index]}px`,
        height: `${height}px`,
        lineHeight: `${height}px`,
        fontSize: `${height * style.scale}px`,
        transformOrigin: '0 0',
      });
      this.appendGlyphs(text, row, glyphs, style, view.spans);
      element.append(text);
      // Rows keep their native width; wider browser text is compressed (reader rules too).
      const last = row.at(-1)!;
      const native = last.x + last.width - row[0]!.x,
        measured = text.offsetWidth;
      if (measured > native) text.style.transform = `scaleX(${native / measured})`;
    });
  }

  /**
   * Styled vertical text: `fit` keeps the native columns, compressed to their native height;
   * `natural` flows the text down the object's height and from its right edge leftwards.
   */
  private renderStyledColumns(
    view: BlockView,
    columns: readonly BakedGlyph[][],
    glyphs: readonly BakedGlyph[],
    block: RScriptNode,
    style: DomTextStyle,
  ): void {
    const {document} = this.options;
    const {element} = view;
    const size = Math.max(...glyphs.map((g) => g.width));
    const classes = [
      domTextClasses.text,
      domTextClasses.vertical,
      ...(columns.length > 1 ? [domTextClasses.multiline] : []),
    ].join(' ');
    const line = (): HTMLElement => {
      const text = document.createElement('div');
      text.dataset.line = '';
      text.className = classes;
      text.lang = 'ja';
      text.dataset.fontSize = String(size);
      text.style.writingMode = 'vertical-rl';
      return text;
    };
    if (style.layout === 'natural') {
      const first = columns[0]!;
      const right = first[0]!.x + size;
      const top = Math.min(...first.map((g) => g.y));
      const pitch = columns.length > 1 ? first[0]!.x - columns[1]![0]!.x : size;
      const text = line();
      text.dataset.break = '';
      Object.assign(text.style, {
        right: `${block.width - right}px`,
        top: `${top}px`,
        height: `${Math.max(size, block.height - top)}px`,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        lineHeight: `${Math.max(pitch, size * style.scale * 1.25)}px`,
        fontSize: `${size * style.scale}px`,
      });
      columns.forEach((column, index) => {
        if (index > 0 && column[0]!.newline) text.append('\n');
        this.appendGlyphs(text, column, glyphs, style, view.spans);
      });
      element.append(text);
      return;
    }
    columns.forEach((column, index) => {
      const text = line();
      if (index === 0 || column[0]!.newline) text.dataset.break = '';
      const width = Math.max(...column.map((g) => g.width));
      const top = Math.min(...column.map((g) => g.y));
      Object.assign(text.style, {
        left: `${column[0]!.x}px`,
        top: `${top}px`,
        width: `${width}px`,
        lineHeight: `${width}px`,
        fontSize: `${width * style.scale}px`,
        transformOrigin: '0 0',
      });
      this.appendGlyphs(text, column, glyphs, style, view.spans);
      element.append(text);
      const last = column.at(-1)!;
      const native = last.y + last.height - top,
        measured = text.offsetHeight;
      if (measured > native) text.style.transform = `scaleY(${native / measured})`;
    });
  }

  /** One span per glyph, with ruby over the glyphs it spans within the row. */
  private appendGlyphs(
    parent: HTMLElement,
    row: readonly BakedGlyph[],
    glyphs: readonly BakedGlyph[],
    style: DomTextStyle,
    spans: HTMLElement[],
  ): void {
    const {document, families} = this.options;
    for (let i = 0; i < row.length;) {
      const glyph = row[i]!;
      const span = glyph.ruby ? Math.min(glyph.ruby.span, row.length - i) : 1;
      const target = glyph.ruby ? document.createElement('ruby') : parent;
      for (const cell of row.slice(i, i + span)) {
        const element = document.createElement('span');
        element.textContent = cell.text;
        Object.assign(element.style, {
          color: `#${(cell.color & 0xffffff).toString(16).padStart(6, '0')}`,
          fontFamily: domTextFamily(style, families(cell.face)),
          fontWeight: String(style.weight ?? (cell.bold ? 'bold' : 'normal')),
          fontStyle: cell.italic ? 'italic' : 'normal',
          // The native shadow (0x456C00) is black, a twelfth of the size down and right.
          textShadow:
            style.effects && cell.shadow
              ? `${Math.trunc(cell.height / 12)}px ${Math.trunc(cell.height / 12)}px #000`
              : 'none',
        });
        spans[glyphs.indexOf(cell)] = element;
        target.append(element);
      }
      if (glyph.ruby) {
        const rt = document.createElement('rt');
        rt.className = 'game-text-ruby';
        rt.textContent = glyph.ruby.text;
        rt.style.color = `#${(glyph.color & 0xffffff).toString(16).padStart(6, '0')}`;
        target.append(rt);
        parent.append(target);
      }
      i += span;
    }
  }

  /** Copies the selection without ruby or the newlines of visual wraps. */
  private copy(event: ClipboardEvent): void {
    const selection = this.options.document.getSelection();
    if (!selection || selection.rangeCount === 0 || !event.clipboardData) return;
    const range = selection.getRangeAt(0);
    let text = '';
    for (const line of this.element.querySelectorAll<HTMLElement>('[data-line]')) {
      if (!range.intersectsNode(line)) continue;
      const part = this.options.document.createRange();
      part.selectNodeContents(line);
      if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0)
        part.setStart(range.startContainer, range.startOffset);
      if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0)
        part.setEnd(range.endContainer, range.endOffset);
      const contents = part.cloneContents();
      for (const rt of contents.querySelectorAll('rt')) rt.remove();
      const piece = contents.textContent ?? '';
      if (!piece) continue;
      if (text && line.dataset.break !== undefined) text += '\n';
      text += piece;
    }
    if (!text) return;
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
  }

  private clear(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    for (const view of this.blocks.values()) view.element.remove();
    this.blocks.clear();
  }

  dispose(): void {
    this.unsubscribeStyle();
    this.resize.disconnect();
    this.clear();
    this.element.remove();
  }
}

/**
 * Visible text objects and nodes with text drawn into their images (choice plates), in
 * drawing order; hidden containers hide their text.
 */
function collect(node: RScriptNode, out: RScriptNode[]): void {
  if (!node.visible) return;
  if (node instanceof RScriptTextBlock || node.bakedText) out.push(node);
  else if (node instanceof RScriptContainer) for (const child of node.nodes()) collect(child, out);
}
