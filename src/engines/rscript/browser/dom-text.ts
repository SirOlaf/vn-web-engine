import {DomGlyphSlots} from '../../../text/dom-glyph-slots.js';
import type {GlyphSlot, TextGlyph} from '../../../text/glyph-slots.js';
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

  constructor(private readonly options: RScriptDomTextOptions) {
    const {parent, canvas, width, height} = options;
    this.slots = new DomGlyphSlots(parent, {overlay: true});
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
        }
        z++;
      }
    }
    for (const id of this.shown.keys()) if (!visible.has(id)) this.shown.delete(id);
    this.slots.retain(visible);
  }

  private clear(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.shown.clear();
    this.slots.clear();
  }

  dispose(): void {
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
          text: g.text,
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
