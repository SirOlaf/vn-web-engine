import {DomGlyphSlots} from '../../../text/dom-glyph-slots.js';
import type {GlyphSlot, TextGlyph} from '../../../text/glyph-slots.js';
import {getDomTextStyle, subscribeDomTextStyle} from '../../../text/dom-text-style.js';
import {objectFitPlacement} from '../../../graphics/object-fit.js';
import {
  artemisTextVisibility,
  type ArtemisTextCell,
  type ArtemisTextLayer,
} from '../image-graphics.js';

export interface ArtemisDomTextOptions {
  readonly document: Document;
  /** The element the layer is placed in; it must be positioned. */
  readonly parent: HTMLElement;
  /** The stage canvas the layer lines up with. */
  readonly canvas: HTMLCanvasElement;
  readonly width: number;
  readonly height: number;
  /** The text layers the stage draws, in drawing order. */
  layers(): readonly ArtemisTextLayer[];
  /** A font file of the game, for the browser face of its text. */
  readFont(path: string): Promise<Uint8Array | null>;
  /** Stops the stage drawing text while styled browser text presents it. */
  hideText(hidden: boolean): void;
}

export interface ArtemisShownSlot {
  readonly slot: GlyphSlot;
  /** The cells' font file, or null. */
  readonly face: string | null;
}

/** The stage rect of a cell's em box: the painted surface puts the outline radius before
 * the glyph and the shadow offset after it, so both are outside the box. Its opacity is
 * what the image layers drawn over the text leave of it at the box centre. */
function cellGlyph(layer: ArtemisTextLayer, cell: ArtemisTextCell, id: number, line: number) {
  const [a, b, tx, c, d, ty] = layer.matrix as unknown as number[],
    [p, q, r, s, t, u] = cell.matrix as unknown as number[];
  // The cell matrix after the layer matrix.
  const m0 = a! * p! + b! * s!,
    m1 = a! * q! + b! * t!,
    m3 = c! * p! + d! * s!,
    m4 = c! * q! + d! * t!,
    edge = cell.outline;
  const x = a! * r! + b! * u! + tx! + m0 * edge + m1 * edge,
    y = c! * r! + d! * u! + ty! + m3 * edge + m4 * edge,
    scaleX = Math.hypot(m0, m3),
    scaleY = Math.hypot(m1, m4),
    width = Math.max(0, cell.advance - 2 * edge - cell.shadow) * scaleX,
    height = cell.size * scaleY,
    visible = artemisTextVisibility(layer.covers, x + width / 2, y + height / 2);
  const glyph: TextGlyph = {
    id,
    x,
    y,
    width,
    height,
    size: cell.size * scaleY,
    text: cell.text,
    line,
    color: cell.color & 0xffffff,
    alpha: Math.round(Math.min(1, Math.max(0, cell.alpha * layer.alpha * visible)) * 255),
    ...(layer.clip ? {clip: layer.clip} : {}),
    ...(cell.shadow > 0
      ? {
          shadows: [
            {
              x: cell.shadow * scaleX,
              y: cell.shadow * scaleY,
              color: cell.shadowcolor & 0xffffff,
              alpha: 255,
            },
          ],
        }
      : {}),
    ...(edge > 0
      ? {
          outline: {
            radiusX: edge * scaleX,
            radiusY: edge * scaleY,
            color: cell.outlinecolor & 0xffffff,
            alpha: 255,
          },
        }
      : {}),
  };
  return glyph;
}

interface Bounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/**
 * Keeps the text of a layer inside `bounds` when any of it is drawn there: each display line
 * starts inside them, and the part of a line past the right edge wraps onto new rows below
 * it at the line's start, breaking before the word (block) that crosses the edge, or inside
 * a word wider than a row. Later lines move down by the added rows (the layer's line pitch,
 * or the line height for one line). Then the text moves up when it ends below the bounds, or
 * down when it starts above them, as far as the other edge allows. A layer with nothing
 * inside the bounds is not drawn and stays where it is. Returns the moved glyphs with their
 * rows, and the move of each block's first glyph.
 */
export function artemisFitTextRows(
  glyphs: readonly TextGlyph[],
  cells: readonly ArtemisTextCell[],
  bounds: Bounds,
): {glyphs: TextGlyph[]; blocks: Map<number, {dx: number; dy: number}>} {
  const {left, top, right, bottom} = bounds;
  const moved: TextGlyph[] = glyphs.map((g) => ({...g})),
    blocks = new Map<number, {dx: number; dy: number}>();
  if (
    !glyphs.some((g) => g.x < right && g.x + g.width > left && g.y < bottom && g.y + g.height > top)
  )
    return {glyphs: moved, blocks};
  const lines = new Map<number, number[]>();
  glyphs.forEach((_, index) => {
    const line = cells[index]!.line;
    lines.set(line, [...(lines.get(line) ?? []), index]);
  });
  const order = [...lines.keys()].sort((a, b) => a - b),
    tops = order.map((line) => Math.min(...lines.get(line)!.map((i) => glyphs[i]!.y))),
    pitches = tops
      .slice(1)
      .map((y, i) => y - tops[i]!)
      .filter((d) => d > 0);
  let row = 0,
    shift = 0;
  for (const line of order) {
    const indices = lines.get(line)!,
      first = glyphs[indices[0]!]!,
      start = Math.max(left, Math.min(first.x, right - first.width)),
      step = pitches.length
        ? Math.min(...pitches)
        : Math.max(...indices.map((i) => glyphs[i]!.height));
    let dx = start - first.x,
      rowStart = 0;
    for (let k = 0; k < indices.length; k++) {
      const g = glyphs[indices[k]!]!;
      if (k > rowStart && g.x + dx + g.width > right) {
        // Break before the word that crosses the edge, unless it starts the row.
        const block = cells[indices[k]!]!.block;
        let wrap = k;
        while (wrap > rowStart + 1 && cells[indices[wrap - 1]!]!.block === block) wrap--;
        if (cells[indices[wrap - 1]!]!.block !== block) k = wrap;
        rowStart = k;
        row++;
        shift += step;
        dx = start - glyphs[indices[k]!]!.x;
      }
      const h = glyphs[indices[k]!]!;
      Object.assign(moved[indices[k]!]!, {x: h.x + dx, y: h.y + shift, line: row});
    }
    row++;
  }
  const high = Math.min(...moved.map((g) => g.y)),
    low = Math.max(...moved.map((g) => g.y + g.height)),
    dy =
      low > bottom
        ? -Math.min(low - bottom, Math.max(0, high - top))
        : high < top
          ? Math.min(top - high, bottom - low)
          : 0;
  if (dy) for (const g of moved) g.y += dy;
  moved.forEach((g, index) => {
    const block = cells[index]!.block;
    if (!blocks.has(block))
      blocks.set(block, {dx: g.x - glyphs[index]!.x, dy: g.y - glyphs[index]!.y});
  });
  return {glyphs: moved, blocks};
}

/**
 * The slots of one text layer: a slot per run of body characters sharing a font, with the
 * layer's display lines as explicit rows, and a slot per word's ruby that is not selected.
 * Colours, opacity (reveal fades and covering layers included) and effects stay per
 * character. Text partly outside the stage rect and the layer's clip is moved and wrapped
 * inside them (`artemisFitTextRows`); a layer with nothing inside them is not drawn and its
 * slots are left out.
 */
export function artemisTextSlots(
  prefix: string,
  layer: ArtemisTextLayer,
  cells: readonly ArtemisTextCell[],
  stage: {readonly width: number; readonly height: number},
): ArtemisShownSlot[] {
  const result: ArtemisShownSlot[] = [],
    main = cells.filter((cell) => !cell.ruby);
  const clip = layer.clip,
    bounds: Bounds = {
      left: Math.max(0, clip?.x ?? 0),
      top: Math.max(0, clip?.y ?? 0),
      right: Math.min(stage.width, clip ? clip.x + clip.width : Infinity),
      bottom: Math.min(stage.height, clip ? clip.y + clip.height : Infinity),
    };
  const fitted = artemisFitTextRows(
    main.map((c, index) => cellGlyph(layer, c, index, c.line)),
    main,
    bounds,
  );
  if (!fitted.blocks.size) return result;
  let start = 0;
  for (let i = 1; i <= main.length; i++) {
    const first = main[start]!,
      cell = main[i];
    if (
      cell &&
      cell.face === first.face &&
      cell.size === first.size &&
      cell.bold === first.bold &&
      cell.italic === first.italic
    )
      continue;
    result.push({
      face: first.face,
      slot: {
        id: `${prefix}-${start}`,
        explicitLines: true,
        bold: first.bold,
        italic: first.italic,
        glyphs: fitted.glyphs.slice(start, i),
      },
    });
    start = i;
  }
  const ruby = new Map<number, ArtemisTextCell[]>();
  for (const cell of cells)
    if (cell.ruby) ruby.set(cell.block, [...(ruby.get(cell.block) ?? []), cell]);
  for (const [block, run] of ruby) {
    // Ruby moves with its word.
    const move = fitted.blocks.get(block) ?? {dx: 0, dy: 0};
    result.push({
      face: run[0]!.face,
      slot: {
        id: `${prefix}-ruby-${block}`,
        interactive: false,
        bold: run[0]!.bold,
        italic: run[0]!.italic,
        classes: ['game-text-ruby'],
        glyphs: run.map((c, j) => {
          const g = cellGlyph(layer, c, j, 0);
          return {...g, x: g.x + move.dx, y: g.y + move.dy};
        }),
      },
    });
  }
  return result;
}

/**
 * Selectable text for copying and dictionary extensions over each text layer the stage
 * draws (messages, backlog and menu text), presented by the shared DOM glyph slots. Without
 * a reader style the stage keeps drawing the glyphs and the text lies transparent over them;
 * with one the stage draws no text and the slots show it in the reader's style. Browser
 * faces load from the game's font files.
 */
export class ArtemisDomText {
  private readonly slots: DomGlyphSlots;
  private readonly shown = new Map<string, string>();
  private readonly resize: ResizeObserver;
  private readonly unsubscribeStyle: () => void;
  private readonly faces = new Map<string, string>();
  private enabled = false;
  /** The layers and revisions shown last; an unchanged stage skips the slot comparison. */
  private sampled = '';

  constructor(private readonly options: ArtemisDomTextOptions) {
    const {parent, canvas, width, height} = options;
    this.slots = new DomGlyphSlots(parent, {overlay: true});
    this.slots.setSize(width, height);
    this.slots.element.hidden = true;
    this.resize = new ResizeObserver(() => this.relayout());
    this.resize.observe(canvas);
    this.relayout();
    this.unsubscribeStyle = subscribeDomTextStyle(() => this.restyle());
  }

  get element(): HTMLElement {
    return this.slots.element;
  }
  get active(): boolean {
    return this.enabled;
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

  /** Re-reads canvas placement; box resizes are observed, `object-fit` changes are not. */
  relayout(): void {
    const {canvas, parent, width, height} = this.options;
    const r = canvas.getBoundingClientRect(),
      p = parent.getBoundingClientRect();
    const {scaleX, scaleY, offsetX, offsetY} = objectFitPlacement(canvas, r, width, height);
    Object.assign(this.slots.element.style, {
      left: `${r.left - p.left + offsetX}px`,
      top: `${r.top - p.top + offsetY}px`,
      transform: scaleX === scaleY ? `scale(${scaleX || 1})` : `scale(${scaleX}, ${scaleY})`,
    });
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.element.hidden = !enabled;
    if (!enabled) {
      this.shown.clear();
      this.slots.clear();
    }
    this.restyle();
  }

  /** Applies the reader's style: every slot is shown again and the stage text follows. */
  private restyle(): void {
    this.options.hideText(this.enabled && getDomTextStyle().enabled);
    this.shown.clear();
    this.sampled = '';
    this.update();
  }

  /** Follows the stage after it is drawn. */
  update(): void {
    if (!this.enabled) return;
    const layers = this.options.layers();
    // Each layer's covers end the first layer's, so those are sampled once.
    const sample = JSON.stringify([
      layers.map((layer) => [
        layer.id,
        layer.text.revision,
        Array.from(layer.matrix),
        layer.alpha,
        layer.clip,
        layer.covers.length,
      ]),
      (layers[0]?.covers ?? []).map((cover) => [
        cover.id,
        cover.texture,
        Array.from(cover.matrix),
        cover.alpha,
        cover.left,
        cover.top,
        cover.width,
        cover.height,
      ]),
    ]);
    if (sample === this.sampled) return;
    this.sampled = sample;
    const visible = new Set<string>();
    let z = 0;
    for (const layer of layers) {
      const cells = layer.text.cells?.() ?? [];
      if (!cells.length) continue;
      for (const {slot, face} of artemisTextSlots(
        `artemis-${layer.id}`,
        layer,
        cells,
        this.options,
      )) {
        const family = this.family(face);
        visible.add(slot.id);
        // Showing only on change keeps a selection while the text stays the same.
        const key = JSON.stringify([z, family, slot]);
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

  /** The CSS families of a font file; the face is added to the document once it loads. */
  private family(face: string | null): string {
    if (face === null) return 'sans-serif';
    let family = this.faces.get(face);
    if (!family) {
      family = `ArtemisFace${this.faces.size + 1}`;
      this.faces.set(face, family);
      const name = family;
      void (async () => {
        const bytes = await this.options.readFont(face);
        if (!bytes) return;
        const loaded = await new FontFace(name, bytes.slice().buffer).load();
        this.options.document.fonts.add(loaded);
        // Slots measured with the fallback face are shown again.
        this.shown.clear();
        this.sampled = '';
      })().catch(() => {});
    }
    return `"${family}", sans-serif`;
  }

  dispose(): void {
    this.unsubscribeStyle();
    this.resize.disconnect();
    const families = new Set(this.faces.values()),
      fonts = this.options.document.fonts;
    for (const face of [...fonts])
      if (families.has(face.family.replaceAll('"', ''))) fonts.delete(face);
    this.slots.dispose();
  }
}
