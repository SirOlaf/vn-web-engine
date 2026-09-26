import {DomGlyphSlots} from './dom-glyph-slots.js';
import type {GlyphSlot, TextGlyph} from './glyph-slots.js';
import {rasterTextGlyphKey, type RasterTextGlyph} from './raster-text.js';

/** Group visible fragments into continuous browser-shaped text, not one node per glyph. */
export function rasterTextSlots(
  glyphs: readonly RasterTextGlyph[],
): {slot: GlyphSlot; family: string}[] {
  const unique = new Map<string, RasterTextGlyph>();
  for (const g of glyphs) {
    if (!(g.alpha > 0 && g.width > 0 && g.height > 0)) continue;
    const key = rasterTextGlyphKey(g);
    const previous = unique.get(key);
    if (previous) {
      const x = Math.min(previous.clip.x, g.clip.x),
        y = Math.min(previous.clip.y, g.clip.y);
      // Retained damage strips precede newer draws. Geometry is shared, but the
      // native fade/tint can change between them: preserve coverage while taking
      // the latest style, rather than freezing the first reveal's dim alpha.
      unique.set(key, {
        ...g,
        clip: {
          x,
          y,
          width: Math.max(previous.clip.x + previous.clip.width, g.clip.x + g.clip.width) - x,
          height: Math.max(previous.clip.y + previous.clip.height, g.clip.y + g.clip.height) - y,
        },
      });
    } else unique.set(key, {...g, clip: {...g.clip}});
  }
  const rows = new Map<string, RasterTextGlyph[]>();
  for (const g of unique.values()) {
    const key = JSON.stringify([
      g.vertical,
      Math.round(g.vertical ? g.x : g.y),
      g.family,
      g.bold,
      g.size,
      g.color,
      g.flow ?? null,
    ]);
    const row = rows.get(key) ?? [];
    row.push(g);
    rows.set(key, row);
  }
  const output: {slot: GlyphSlot; family: string}[] = [];
  for (const [key, row] of rows) {
    row.sort((a, b) => (a.vertical ? a.y - b.y : a.x - b.x));
    let run: RasterTextGlyph[] = [];
    const flush = () => {
      if (!run.length) return;
      const first = run[0]!;
      const glyphs: TextGlyph[] = run.map((g) => ({...g, line: 0}));
      output.push({
        slot: {
          id: `raster/${key}/${first.x}/${first.y}`,
          glyphs,
          explicitLines: true,
          vertical: first.vertical,
          bold: first.bold,
        },
        family: first.family,
      });
      run = [];
    };
    for (const glyph of row) {
      const previous = run.at(-1);
      if (
        previous &&
        (glyph.vertical
          ? glyph.y - previous.y - previous.height
          : glyph.x - previous.x - previous.width) >
          glyph.size * 1.5
      )
        flush();
      run.push(glyph);
    }
    flush();
  }
  // Preserve dictionary/copy continuity across adjacent native rows. Ruby and
  // separately styled controls remain independent slots. No separator characters
  // are added to the game's string for visual wrapping.
  const blocks: typeof output = [];
  output.sort(
    (a, b) =>
      a.slot.glyphs[0]!.y - b.slot.glyphs[0]!.y || a.slot.glyphs[0]!.x - b.slot.glyphs[0]!.x,
  );
  for (const row of output) {
    const first = row.slot.glyphs[0]!;
    const previous =
      !row.slot.vertical &&
      blocks
        .slice()
        .reverse()
        .find((block) => {
          const start = block.slot.glyphs[0]!,
            last = block.slot.glyphs.at(-1)!;
          return (
            !block.slot.vertical &&
            block.family === row.family &&
            block.slot.bold === row.slot.bold &&
            start.color === first.color &&
            start.flow === first.flow &&
            (start.size ?? start.height) === (first.size ?? first.height) &&
            start.height === first.height &&
            // Dialogue often hangs its continuation under the opening quote.
            // Keep that indentation in one selectable paragraph.
            Math.abs(start.x - first.x) <= first.height * 1.5 &&
            first.y - last.y >= first.height &&
            first.y - last.y <= first.height * 2 &&
            // A single CSS text flow has one line advance. Keep unrelated rows
            // with different spacing out of this paragraph.
            (last.line === 0 ||
              (Math.abs((last.y - start.y) / last.line - (first.y - last.y)) < 0.5 &&
                Math.abs(block.slot.glyphs.find((g) => g.line === 1)!.x - first.x) < 0.5))
          );
        });
    if (previous) {
      const line = previous.slot.glyphs.at(-1)!.line + 1;
      previous.slot.glyphs = [
        ...previous.slot.glyphs,
        ...row.slot.glyphs.map((g) => ({...g, line})),
      ];
    } else blocks.push(row);
  }
  return blocks;
}

/** An alternate presentation only: the underlying game canvas and readbacks stay native. */
export class BrowserRasterText {
  readonly text: DomGlyphSlots;
  private readonly background: HTMLCanvasElement;
  private readonly resize: ResizeObserver;
  constructor(readonly canvas: HTMLCanvasElement) {
    const parent = canvas.parentElement;
    if (!parent) throw new Error('DOM text requires an attached presentation canvas');
    this.text = new DomGlyphSlots(parent);
    this.text.element.hidden = true;
    this.background = canvas.ownerDocument.createElement('canvas');
    this.background.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:0';
    this.text.element.append(this.background);
    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(canvas);
  }
  private fit(): void {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const c = this.canvas.getBoundingClientRect(),
      p = parent.getBoundingClientRect();
    if (p.width <= 0 || p.height <= 0 || parent.offsetWidth <= 0 || parent.offsetHeight <= 0)
      return;
    // The layer is a sibling of the canvas, so both inherit the window's scale.
    // Convert viewport measurements back into the parent's layout coordinates
    // before positioning/scaling the layer; otherwise that scale is applied twice.
    const scaleX = p.width / parent.offsetWidth,
      scaleY = p.height / parent.offsetHeight;
    Object.assign(this.text.element.style, {
      left: `${(c.left - p.left) / scaleX + parent.scrollLeft - parent.clientLeft}px`,
      top: `${(c.top - p.top) / scaleY + parent.scrollTop - parent.clientTop}px`,
      transform: `scale(${c.width / scaleX / this.background.width},${c.height / scaleY / this.background.height})`,
    });
  }
  show(frame: ImageData, glyphs: readonly RasterTextGlyph[]): void {
    if (this.background.width !== frame.width) this.background.width = frame.width;
    if (this.background.height !== frame.height) this.background.height = frame.height;
    this.background.getContext('2d')!.putImageData(frame, 0, 0);
    this.text.setSize(frame.width, frame.height);
    const visible = new Set<string>();
    for (const {slot, family} of rasterTextSlots(glyphs)) {
      this.text.show(slot, 1, family, false);
      visible.add(slot.id);
    }
    this.text.retain(visible);
    this.text.element.hidden = false;
    this.fit();
  }
  hide(): void {
    this.text.element.hidden = true;
    this.text.clear();
  }
  dispose(): void {
    this.resize.disconnect();
    this.text.dispose();
    this.background.width = this.background.height = 0;
  }
}
