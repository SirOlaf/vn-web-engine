import {slotText, type GlyphSlot, type TextGlyph} from './glyph-slots.js';
let nextTint = 0;
/** One continuous light-DOM Text node per slot. Native line boundaries are
 * expressed through CSS wrapping, never characters inserted into the text. */
export class DomGlyphSlots {
  readonly element = document.createElement('div');
  readonly buffers = new Map<string, readonly TextGlyph[]>();
  private readonly nodes = new Map<
    string,
    {
      box: HTMLDivElement;
      text: HTMLSpanElement;
      node: Text;
      highlights: HTMLDivElement[];
      tint?: {filter: SVGFilterElement; id: string; key: string};
    }
  >();
  private readonly measure = document.createElement('canvas').getContext('2d')!;
  private selectionFrame = 0;
  private readonly queueSelection = () => {
    if (!this.selectionFrame)
      this.selectionFrame = requestAnimationFrame(() => {
        this.selectionFrame = 0;
        this.paintSelection();
      });
  };
  constructor(parent: HTMLElement) {
    this.element.className = 'game-glyph-slots';
    this.element.style.cssText =
      'position:absolute;width:1920px;height:1080px;overflow:hidden;pointer-events:none;transform-origin:0 0';
    parent.append(this.element);
    document.addEventListener('selectionchange', this.queueSelection);
  }
  show(slot: GlyphSlot, z: number, family?: string): void {
    this.buffers.set(slot.id, slot.glyphs);
    const content = slotText(slot);
    let nodes = this.nodes.get(slot.id);
    if (!content) {
      if (nodes) nodes.box.hidden = true;
      return;
    }
    if (!nodes) {
      const box = document.createElement('div'),
        text = document.createElement('span'),
        node = document.createTextNode('');
      box.dataset.textId = slot.id;
      text.dataset.gameText = '';
      text.lang = 'ja';
      text.tabIndex = 0;
      text.append(node);
      box.append(text);
      this.element.append(box);
      nodes = {box, text, node, highlights: []};
      this.nodes.set(slot.id, nodes);
    }
    const {box, text, node} = nodes,
      {bounds, clip} = content;
    box.hidden = false;
    const interactive = slot.interactive !== false;
    box.inert = !interactive;
    text.tabIndex = interactive ? 0 : -1;
    if (!interactive) {
      if (document.getSelection()?.containsNode(node, true))
        document.getSelection()?.removeAllRanges();
      if (document.activeElement === text) text.blur();
      for (const highlight of nodes.highlights.splice(0)) highlight.remove();
    }
    // Update only the changed suffix, preserving the node and selections in the prefix.
    if (node.data !== content.text) {
      let prefix = 0;
      while (
        prefix < node.length &&
        prefix < content.text.length &&
        node.data[prefix] === content.text[prefix]
      )
        prefix++;
      node.replaceData(prefix, node.length - prefix, content.text.slice(prefix));
    }
    const size = Math.min(content.size, bounds.height / content.lines),
      font = `${size}px ${family ?? 'serif'}`;
    this.measure.font = font;
    this.measure.fontKerning = 'none';
    const fullLines = Array.from({length: content.lines}, () => '');
    const firstLine = Math.min(...slot.glyphs.map((g) => g.line));
    for (const g of slot.glyphs) fullLines[g.line - firstLine] += g.text ?? '';
    const widths = fullLines.map((line) => this.measure.measureText(line).width);
    const measured = Math.max(1, ...widths),
      scale = Math.min(1, bounds.width / measured);
    const lineHeight = content.lines > 1 ? (bounds.height - size) / (content.lines - 1) : size;
    // An empty floated pseudo-element reserves the unused right side of each
    // native line. Even short lines and blank rows wrap without splitting the
    // Text node or inserting separators that interrupt dictionary scanning.
    // Leave a small allowance for CSS subpixel rounding of measured advances.
    const wrapWidth = measured + 1 / 16;
    const edge = widths.flatMap((width, line) => {
      const x = width ? width + 1 / 16 : 0;
      return [`${x}px ${line * lineHeight}px`, `${x}px ${(line + 1) * lineHeight}px`];
    });
    const shape = `polygon(${wrapWidth}px 0,${edge.join(',')},${wrapWidth}px ${content.lines * lineHeight}px)`;
    box.style.cssText = `position:absolute;left:${clip.x}px;top:${clip.y}px;width:${clip.width}px;height:${clip.height}px;overflow:hidden;pointer-events:none;z-index:${z}`;
    let filter = '';
    if (family || content.shadows.length) {
      const ns = 'http://www.w3.org/2000/svg';
      if (!nodes.tint) {
        const svg = document.createElementNS(ns, 'svg'),
          f = document.createElementNS(ns, 'filter'),
          id = `atlas-tint-${++nextTint}`;
        svg.setAttribute('width', '0');
        svg.setAttribute('height', '0');
        svg.style.position = 'absolute';
        f.id = id;
        f.setAttribute('color-interpolation-filters', 'sRGB');
        svg.append(f);
        box.append(svg);
        nodes.tint = {filter: f, id, key: ''};
      }
      const c = family ? content.color : 0xffffff,
        key = JSON.stringify([
          c,
          content.shadows,
          content.alpha,
          scale,
          measured,
          lineHeight,
          content.lines,
        ]);
      if (nodes.tint.key !== key) {
        const f = nodes.tint.filter;
        f.replaceChildren();
        // Derive every effect from the browser-shaped glyph alpha, before tinting.
        // Independent branches avoid casting shadows from other shadow passes.
        const primitive = (name: string, attributes: Record<string, string | number>) => {
          const e = document.createElementNS(ns, name);
          for (const [k, v] of Object.entries(attributes)) e.setAttribute(k, String(v));
          f.append(e);
          return e;
        };
        const minX = Math.min(0, ...content.shadows.map((s) => s.x)) / scale,
          minY = Math.min(0, ...content.shadows.map((s) => s.y)),
          maxX = Math.max(0, ...content.shadows.map((s) => s.x)) / scale,
          maxY = Math.max(0, ...content.shadows.map((s) => s.y));
        f.setAttribute('filterUnits', 'userSpaceOnUse');
        f.setAttribute('x', String(minX - 1));
        f.setAttribute('y', String(minY - 1));
        f.setAttribute('width', String(measured + maxX - minX + 2));
        f.setAttribute('height', String(lineHeight * content.lines + maxY - minY + 2));
        primitive('feColorMatrix', {
          type: 'matrix',
          in: 'SourceGraphic',
          result: 'ink',
          values: `${((c >>> 16) & 255) / 255} 0 0 0 0 0 ${((c >>> 8) & 255) / 255} 0 0 0 0 0 ${(c & 255) / 255} 0 0 0 0 0 ${Math.max(0, Math.min(255, content.alpha)) / 255} 0`,
        });
        for (const [i, shadow] of content.shadows.entries()) {
          primitive('feOffset', {
            in: 'SourceAlpha',
            dx: shadow.x / scale,
            dy: shadow.y,
            result: `offset-${i}`,
          });
          primitive('feFlood', {
            'flood-color': `#${(shadow.color & 0xffffff).toString(16).padStart(6, '0')}`,
            'flood-opacity': Math.max(0, Math.min(255, shadow.alpha)) / 255,
            result: `color-${i}`,
          });
          primitive('feComposite', {
            in: `color-${i}`,
            in2: `offset-${i}`,
            operator: 'in',
            result: `shadow-${i}`,
          });
        }
        const merge = primitive('feMerge', {});
        for (const name of [...content.shadows.map((_, i) => `shadow-${i}`), 'ink']) {
          const e = document.createElementNS(ns, 'feMergeNode');
          e.setAttribute('in', name);
          merge.append(e);
        }
        nodes.tint.key = key;
      }
      filter = `filter:url(#${nodes.tint.id});`;
    }
    text.style.cssText = `position:absolute;display:block;left:${bounds.x - clip.x}px;top:${bounds.y - clip.y - (lineHeight - size) / 2}px;width:${wrapWidth}px;--text-wrap-height:${content.lines * lineHeight}px;--text-wrap-shape:${shape};white-space:break-spaces;word-break:break-all;line-break:anywhere;hyphens:none;font:${font};font-kerning:none;font-variant-ligatures:none;${filter}line-height:${lineHeight}px;color:#${(content.color & 0xffffff).toString(16).padStart(6, '0')};opacity:${filter ? 1 : Math.min(255, content.alpha) / 255};transform:scaleX(${scale});transform-origin:0 0;user-select:${interactive ? 'text' : 'none'};-webkit-user-select:${interactive ? 'text' : 'none'};pointer-events:${interactive ? 'auto' : 'none'};cursor:${interactive ? 'text' : 'default'};outline:none`;
    if (document.getSelection()?.containsNode(node, true) || nodes.highlights.length)
      this.queueSelection();
  }
  /** Paint range rectangles as siblings of the filtered glyphs. Native selection
   * backgrounds are tinted with the font and can become black during animation. */
  private paintSelection(): void {
    const selection = document.getSelection(),
      layer = this.element.getBoundingClientRect(),
      sx = layer.width / 1920,
      sy = layer.height / 1080;
    for (const {box, node, highlights} of this.nodes.values()) {
      const rectangles: DOMRect[] = [];
      if (selection && !selection.isCollapsed && !box.hidden && !box.inert && sx > 0 && sy > 0) {
        for (let i = 0; i < selection.rangeCount; i++) {
          const selected = selection.getRangeAt(i);
          if (!selected.intersectsNode(node)) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          if (selected.startContainer === node) range.setStart(node, selected.startOffset);
          if (selected.endContainer === node) range.setEnd(node, selected.endOffset);
          rectangles.push(
            ...Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0),
          );
        }
      }
      const origin = rectangles.length ? box.getBoundingClientRect() : undefined;
      for (const [i, r] of rectangles.entries()) {
        let highlight = highlights[i];
        if (!highlight) {
          highlight = document.createElement('div');
          highlight.className = 'game-text-selection';
          highlight.setAttribute('aria-hidden', 'true');
          box.append(highlight);
          highlights.push(highlight);
        }
        highlight.style.cssText = `position:absolute;pointer-events:none;user-select:none;left:${(r.x - origin!.x) / sx}px;top:${(r.y - origin!.y) / sy}px;width:${r.width / sx}px;height:${r.height / sy}px`;
      }
      for (const highlight of highlights.splice(rectangles.length)) highlight.remove();
    }
  }
  retain(ids: ReadonlySet<string>, buffers: ReadonlySet<string> = ids): void {
    for (const [id, n] of this.nodes) {
      if (!buffers.has(id)) {
        n.box.remove();
        this.nodes.delete(id);
      } else if (!ids.has(id)) n.box.hidden = true;
    }
    for (const id of this.buffers.keys()) if (!buffers.has(id)) this.buffers.delete(id);
  }
  clear(): void {
    this.retain(new Set());
  }
  dispose(): void {
    document.removeEventListener('selectionchange', this.queueSelection);
    cancelAnimationFrame(this.selectionFrame);
    this.clear();
    this.element.remove();
  }
}
