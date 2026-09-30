import {DomGlyphSlots} from './dom-glyph-slots.js';
import {getDomTextStyle} from './dom-text-style.js';
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
  // Runs with different faces or edges are separately styled text nodes.
  const style = (g: RasterTextGlyph) =>
    JSON.stringify([g.family, g.weight, g.stretch, g.outline ?? null, g.shadows ?? null]);
  const rows = new Map<string, RasterTextGlyph[]>();
  for (const g of unique.values()) {
    const key = JSON.stringify([
      g.vertical,
      Math.round(g.vertical ? g.x : g.y),
      style(g),
      g.size,
      g.color,
      g.flow ?? null,
    ]);
    const row = rows.get(key) ?? [];
    row.push(g);
    rows.set(key, row);
  }
  const output: {slot: GlyphSlot; family: string; style: string}[] = [];
  for (const [key, row] of rows) {
    row.sort((a, b) => (a.vertical ? a.y - b.y : a.x - b.x));
    let run: RasterTextGlyph[] = [];
    const flush = () => {
      // Leading whitespace is indentation, which the first visible glyph's position already
      // carries. Keeping it would anchor the row to an invisible advance that restyled text
      // widens or narrows, pushing or clipping the first visible glyph.
      while (run.length && run[0]!.text !== undefined && /^\s*$/u.test(run[0]!.text)) run.shift();
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
          weight: first.weight,
          stretch: first.stretch,
        },
        family: first.family,
        style: style(first),
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
            block.style === row.style &&
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

/**
 * Short controls in another flow that sit at the end of a dialogue row, such as a wait
 * marker drawn after the last glyph: [follower, leader] slot ids. Each follower takes the
 * nearest leader whose last visible glyph ends within three glyph widths before it on the
 * same row.
 */
export function rasterTextFollowers(slots: readonly GlyphSlot[]): [string, string][] {
  const visible = (slot: GlyphSlot) => slot.glyphs.filter((g) => g.alpha > 0 && g.text);
  const pairs: [string, string][] = [];
  for (const follower of slots) {
    const glyphs = visible(follower);
    if (follower.vertical || glyphs.length === 0 || glyphs.length > 2) continue;
    const first = glyphs[0]!;
    let best: {id: string; distance: number} | undefined;
    for (const leader of slots) {
      if (leader === follower || leader.vertical) continue;
      const own = visible(leader);
      const last = own.at(-1);
      if (!last || own.length <= glyphs.length || last.flow === first.flow) continue;
      const distance = first.x - (last.x + last.width),
        rowOffset = Math.abs(first.y + first.height / 2 - (last.y + last.height / 2));
      if (rowOffset > last.height / 2 || distance < -last.width / 2 || distance > last.width * 3)
        continue;
      if (!best || Math.abs(distance) < best.distance)
        best = {id: leader.id, distance: Math.abs(distance)};
    }
    if (best) pairs.push([follower.id, best.id]);
  }
  return pairs;
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
    const slots = rasterTextSlots(glyphs),
      followers = rasterTextFollowers(slots.map(({slot}) => slot)),
      markers = new Set(followers.map(([follower]) => follower));
    for (const {slot, family} of slots) {
      const classes = [
        ...(slot.glyphs[0]?.flow !== undefined ? ['game-text-overlay'] : []),
        ...(markers.has(slot.id) ? ['game-text-marker'] : []),
      ];
      this.text.show(classes.length ? {...slot, classes} : slot, 1, family, false);
      visible.add(slot.id);
    }
    // Native placement already puts controls at the native text end.
    if (getDomTextStyle().enabled)
      for (const [follower, leader] of followers) this.text.follow(follower, leader);
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
