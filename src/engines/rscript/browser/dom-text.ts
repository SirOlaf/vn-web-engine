import {DomGlyphSlots} from '../../../text/dom-glyph-slots.js';
import {slotText, type GlyphSlot, type TextGlyph} from '../../../text/glyph-slots.js';
import {getDomTextStyle, subscribeDomTextStyle} from '../../../text/dom-text-style.js';
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
  /** CSS font families of a glyph face, so the browser text matches the glyphs. */
  families(face: number): string;
  /** Stops the canvas drawing text while styled browser text presents it. */
  hideText(hidden: boolean): void;
  /** Input over the text that belongs to the game. */
  wheel(up: boolean): void;
  cancel(): void;
}

interface ShownSlot {
  readonly slot: GlyphSlot;
  readonly family: string;
  readonly signature: string;
}

// RScript packs these ASCII pairs into one upright cell, even in a vertical column.
// Unicode's double punctuation for vertical text preserves that cell without splitting
// the paragraph's Text node. Request text presentation for the emoji-capable symbols.
const verticalPairs: Readonly<Record<string, string>> = {
  '!!': '\u203c\ufe0e',
  '!?': '\u2049\ufe0e',
  '?!': '\u2048',
};
const sourcePairs: Readonly<Record<string, string>> = {'‼': '!!', '⁉': '!?', '⁈': '?!'};

/**
 * Selectable text for copying and dictionary extensions, from each visible text object
 * (message boxes, the backlog pages they show, choices and screen text), presented by the
 * shared DOM glyph slots. Without a reader style the canvas keeps drawing the glyphs and the
 * text lies transparent over them; with one the canvas draws no text and the slots show it
 * in the reader's style. Ruby is a separate slot over its base glyphs that is not selected.
 */
export class RScriptDomText {
  private readonly slots: DomGlyphSlots;
  private readonly shown = new Map<string, string>();
  private readonly ids = new WeakMap<RScriptNode, number>();
  private nextId = 0;
  private readonly resize: ResizeObserver;
  /** Re-reads canvas placement; box resizes are observed, `object-fit` changes are not. */
  readonly relayout: () => void;
  private readonly unsubscribeStyle: () => void;
  private enabled = false;
  private frame = 0;
  private root: RScriptContainer | null = null;
  private readonly copyPairs = (event: ClipboardEvent): void => {
    const selection = this.options.document.getSelection();
    if (
      !event.clipboardData ||
      !this.selected ||
      !selection?.focusNode ||
      !this.element.contains(selection.focusNode)
    )
      return;
    // The shared copy handler has already omitted visual column separators, if any.
    const displayed = event.clipboardData.getData('text/plain') || selection.toString(),
      source = displayed.replace(/[‼⁉⁈]\ufe0e?/g, (pair) => sourcePairs[pair[0]!]!);
    if (source === displayed) return;
    event.clipboardData.setData('text/plain', source);
    event.preventDefault();
  };

  constructor(private readonly options: RScriptDomTextOptions) {
    const {parent, canvas, width, height} = options;
    this.slots = new DomGlyphSlots(parent, {overlay: true});
    options.document.addEventListener('copy', this.copyPairs);
    this.slots.setSize(width, height);
    this.slots.element.hidden = true;
    const fit = (): void => {
      const r = canvas.getBoundingClientRect(),
        p = parent.getBoundingClientRect();
      const {scaleX, scaleY, offsetX, offsetY} = objectFitPlacement(canvas, r, width, height);
      Object.assign(this.slots.element.style, {
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

  get element(): HTMLElement {
    return this.slots.element;
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

  /** Applies the reader's style: every slot is shown again and the canvas text follows. */
  private restyle(): void {
    this.options.hideText(this.enabled && getDomTextStyle().enabled);
    this.shown.clear();
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
    const visible = new Set<string>();
    let z = 0;
    for (const block of found) {
      const glyphs = block instanceof RScriptTextBlock ? block.shownGlyphs() : block.bakedText!;
      if (!glyphs.length) continue;
      let id = this.ids.get(block);
      if (id === undefined) this.ids.set(block, (id = this.nextId++));
      for (const {slot, family, signature} of blockSlots(
        `rscript-${id}`,
        block,
        glyphs,
        this.options,
      )) {
        visible.add(slot.id);
        // Showing only on change keeps a selection while the text stays the same.
        const key = `${z}|${signature}`;
        if (this.shown.get(slot.id) !== key) {
          this.shown.set(slot.id, key);
          this.slots.show(slot, z, family, false);
          if (slot.vertical) this.placeColumns(slot);
        }
        z++;
      }
    }
    for (const id of this.shown.keys()) if (!visible.has(id)) this.shown.delete(id);
    this.slots.retain(visible);
  }

  /** Keep RScript's right-to-left columns anchored as more glyphs are revealed. */
  private placeColumns(slot: GlyphSlot): void {
    const content = slotText(slot);
    if (!content) return;
    const text = this.element.querySelector<HTMLElement>(
      `[data-text-id="${slot.id}"] [data-game-text]`,
    );
    if (!text) return;
    const columns = new Map<number, {right: number; width: number}>();
    for (const glyph of slot.glyphs) {
      const column = columns.get(glyph.line);
      columns.set(glyph.line, {
        right: Math.max(column?.right ?? -Infinity, glyph.x + glyph.width),
        width: Math.max(column?.width ?? 0, glyph.width),
      });
    }
    const first = Math.min(...columns.keys()),
      last = Math.max(...columns.keys()),
      anchor = columns.get(first)!,
      nativePitch =
        last > first ? (anchor.right - columns.get(last)!.right) / (last - first) : anchor.width,
      custom = getDomTextStyle(),
      pitch =
        custom.enabled && custom.layout === 'natural'
          ? Math.max(nativePitch, content.size * custom.scale * 1.25)
          : nativePitch,
      width = (last - first + 1) * pitch;
    // The shared renderer's horizontal origin and whole-block vertical line-height
    // cannot position a multi-column RScript page. Each CSS line box is one column;
    // centre the first box on its native cell and let subsequent boxes grow leftward.
    text.style.left = `${anchor.right + (pitch - anchor.width) / 2 - width - content.clip.x}px`;
    text.style.width = `${width}px`;
    text.style.lineHeight = `${pitch}px`;
    text.style.textIndent = '0px';
  }

  private clear(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.shown.clear();
    this.slots.clear();
  }

  dispose(): void {
    this.options.document.removeEventListener('copy', this.copyPairs);
    this.unsubscribeStyle();
    this.resize.disconnect();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.slots.dispose();
  }
}

/**
 * Line index of each glyph: a row shares a bottom edge (0x45AF80 aligns them to the line
 * height), a column of vertical text a left edge.
 */
function lines(glyphs: readonly BakedGlyph[]): number[] {
  let line = 0;
  return glyphs.map((glyph, i) => {
    const previous = glyphs[i - 1];
    if (
      previous &&
      (glyph.newline ||
        (glyph.vertical
          ? previous.x !== glyph.x
          : previous.y + previous.height !== glyph.y + glyph.height))
    )
      line++;
    return line;
  });
}

/**
 * The slots of one text object: a slot per run of glyphs sharing a face and style, and a
 * slot per ruby annotation. Glyph colours and reveal fades stay per glyph.
 */
function blockSlots(
  prefix: string,
  block: RScriptNode,
  glyphs: readonly BakedGlyph[],
  options: RScriptDomTextOptions,
): ShownSlot[] {
  const at = block.screenPosition();
  // Text outside its object is clipped, as the canvas clips it.
  const clip = {x: at.x, y: at.y, width: block.width, height: block.height};
  const rows = lines(glyphs);
  const alpha = (glyph: BakedGlyph) => Math.round(glyph.opacity * 255);
  const result: ShownSlot[] = [];
  const push = (slot: GlyphSlot, family: string) =>
    result.push({slot, family, signature: JSON.stringify([family, slot])});
  let start = 0;
  for (let i = 1; i <= glyphs.length; i++) {
    const first = glyphs[start]!,
      glyph = glyphs[i];
    if (
      glyph &&
      glyph.face === first.face &&
      glyph.bold === first.bold &&
      glyph.italic === first.italic &&
      !!glyph.vertical === !!first.vertical
    )
      continue;
    const run = glyphs.slice(start, i);
    push(
      {
        id: `${prefix}-${start}`,
        explicitLines: true,
        vertical: !!first.vertical,
        bold: first.bold,
        italic: first.italic,
        glyphs: run.map((g, j): TextGlyph => ({
          id: start + j,
          x: at.x + g.x,
          y: at.y + g.y,
          width: g.width,
          height: g.height,
          text: g.vertical && g.width === g.height ? (verticalPairs[g.text] ?? g.text) : g.text,
          line: rows[start + j]!,
          color: g.color,
          alpha: alpha(g),
          clip,
          // The native shadow (0x456C00) is black, a twelfth of the size down and right.
          ...(g.shadow
            ? {
                shadows: [
                  {
                    x: Math.trunc(g.height / 12),
                    y: Math.trunc(g.height / 12),
                    color: 0,
                    alpha: 255,
                  },
                ],
              }
            : {}),
        })),
      },
      options.families(first.face),
    );
    start = i;
  }
  glyphs.forEach((glyph, index) => {
    if (!glyph.ruby?.glyphs.length) return;
    push(
      {
        id: `${prefix}-ruby-${index}`,
        interactive: false,
        vertical: !!glyph.vertical,
        classes: ['game-text-ruby'],
        glyphs: glyph.ruby.glyphs.map((ruby, j): TextGlyph => ({
          id: j,
          x: at.x + ruby.x,
          y: at.y + ruby.y,
          width: ruby.width,
          height: ruby.height,
          text: ruby.text,
          line: 0,
          color: glyph.color,
          alpha: alpha(glyph),
        })),
      },
      options.families(glyph.face),
    );
  });
  return result;
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
