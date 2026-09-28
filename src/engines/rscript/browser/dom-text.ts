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
  /** CSS font families of the game text, so selections cover the glyphs. */
  readonly fontFamilies: string;
  /** Input over the text that belongs to the game. */
  wheel(up: boolean): void;
  cancel(): void;
}

interface BlockView {
  readonly element: HTMLElement;
  signature: string;
}

const STYLE_ID = 'rscript-dom-text-style';
const STYLE = `
.rscript-dom-text { position: absolute; left: 0; top: 0; transform-origin: 0 0;
  overflow: hidden; pointer-events: none; }
.rscript-dom-text > div { position: absolute; }
.rscript-dom-text [data-line] { position: absolute; white-space: nowrap; color: transparent;
  pointer-events: auto; cursor: text; }
.rscript-dom-text [data-line] > span { display: inline-block; vertical-align: bottom; }
.rscript-dom-text ::selection { background: rgb(64 128 255 / 40%); color: transparent; }
`;

/**
 * Selectable text over the game canvas for copying and dictionary extensions. The native
 * glyphs stay on the canvas; transparent browser text is placed over each visible text
 * object (message boxes, the backlog pages they show, choices and screen text), one span
 * per glyph cell so selections line up with the native layout.
 */
export class RScriptDomText {
  readonly element: HTMLElement;
  private readonly blocks = new Map<RScriptNode, BlockView>();
  private readonly resize: ResizeObserver;
  private enabled = false;
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
    this.element.className = 'rscript-dom-text';
    this.element.style.width = `${width}px`;
    this.element.style.height = `${height}px`;
    this.element.hidden = true;
    parent.append(this.element);
    const fit = (): void => {
      const r = canvas.getBoundingClientRect(),
        p = parent.getBoundingClientRect();
      const scale = Math.min(r.width / width, r.height / height) || 1;
      Object.assign(this.element.style, {
        left: `${r.left - p.left + (r.width - width * scale) / 2}px`,
        top: `${r.top - p.top + (r.height - height * scale) / 2}px`,
        transform: `scale(${scale})`,
      });
    };
    this.resize = new ResizeObserver(fit);
    this.resize.observe(canvas);
    fit();
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
    if (enabled) this.update();
    else this.clear();
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
        `${at.x},${at.y}|` +
        glyphs.map((g) => `${g.text}${g.x},${g.y},${g.width},${g.height}`).join(';');
      let view = this.blocks.get(block);
      if (!view) {
        view = {element: this.options.document.createElement('div'), signature: ''};
        this.blocks.set(block, view);
      }
      // Rebuilding only on change keeps a selection while the text stays the same.
      if (view.signature !== signature) {
        view.signature = signature;
        this.render(view.element, glyphs);
      }
      view.element.style.left = `${at.x}px`;
      view.element.style.top = `${at.y}px`;
      view.element.style.zIndex = String(order);
      if (this.element.children[order] !== view.element)
        this.element.insertBefore(view.element, this.element.children[order] ?? null);
      order++;
    }
    for (const [block, view] of this.blocks)
      if (!keep.has(block)) {
        view.element.remove();
        this.blocks.delete(block);
      }
  }

  private render(element: HTMLElement, glyphs: readonly BakedGlyph[]): void {
    const {document, fontFamilies} = this.options;
    element.replaceChildren();
    // Glyphs of one row share a bottom edge (0x45AF80 aligns them to the line height).
    const rows: BakedGlyph[][] = [];
    for (const glyph of glyphs) {
      const row = rows.at(-1);
      const bottom = glyph.y + glyph.height;
      if (row && row[0]!.y + row[0]!.height === bottom && !glyph.newline) row.push(glyph);
      else rows.push([glyph]);
    }
    rows.forEach((row, index) => {
      const top = Math.min(...row.map((g) => g.y));
      const height = Math.max(...row.map((g) => g.y + g.height)) - top;
      const line = document.createElement('div');
      line.dataset.line = '';
      // Explicit breaks copy as newlines; the layout's own wraps do not.
      if (index === 0 || row[0]!.newline) line.dataset.break = '';
      Object.assign(line.style, {
        left: `${row[0]!.x}px`,
        top: `${top}px`,
        height: `${height}px`,
        lineHeight: `${height}px`,
        fontFamily: fontFamilies,
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

  /** Copies the selection without the newlines of visual wraps. */
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
      const piece = part.toString();
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
