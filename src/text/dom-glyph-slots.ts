import {slotText, type GlyphSlot, type TextGlyph} from './glyph-slots.js';
let nextTint = 0;
let nextInk = 0;
interface InkHighlights {
  style: HTMLStyleElement;
  names: string[];
}
/** One light-DOM Text node per slot. Raster adapters preserve native line
 * boundaries explicitly; adapters with complete buffers can use CSS wrapping. */
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
      explicitLines?: boolean;
      ink?: InkHighlights;
      tint?: {filter: SVGFilterElement; id: string; key: string};
    }
  >();
  private readonly measure = document.createElement('canvas').getContext('2d')!;
  private selectionFrame = 0;
  private width = 1920;
  private height = 1080;
  private readonly queueSelection = () => {
    if (!this.selectionFrame)
      this.selectionFrame = requestAnimationFrame(() => {
        this.selectionFrame = 0;
        this.paintSelection();
      });
  };
  private readonly copy = (event: ClipboardEvent) => {
    const selection = document.getSelection();
    if (!event.clipboardData || selection?.rangeCount !== 1 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    for (const {node, explicitLines} of this.nodes.values()) {
      if (!explicitLines || range.startContainer !== node || range.endContainer !== node) continue;
      // Native visual wraps are presentation-only, as in slotText's source string.
      event.clipboardData.setData('text/plain', range.toString().replaceAll('\n', ''));
      event.preventDefault();
      return;
    }
  };
  constructor(parent: HTMLElement) {
    this.element.className = 'game-glyph-slots';
    this.element.style.cssText =
      'position:absolute;width:1920px;height:1080px;overflow:hidden;pointer-events:none;transform-origin:0 0';
    parent.append(this.element);
    document.addEventListener('selectionchange', this.queueSelection);
    document.addEventListener('copy', this.copy);
  }
  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.element.style.width = `${width}px`;
    this.element.style.height = `${height}px`;
  }
  show(slot: GlyphSlot, z: number, family?: string, atlasTint = true): void {
    this.buffers.set(slot.id, slot.glyphs);
    const content = slotText(slot);
    let nodes = this.nodes.get(slot.id);
    if (!content) {
      if (nodes) {
        nodes.box.hidden = true;
        if (nodes.ink) this.clearInk(nodes.ink);
      }
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
    nodes.explicitLines = slot.explicitLines;
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
    const displayed = slot.explicitLines ? content.visualText : content.text;
    if (node.data !== displayed) {
      let prefix = 0;
      while (
        prefix < node.length &&
        prefix < displayed.length &&
        node.data[prefix] === displayed[prefix]
      )
        prefix++;
      node.replaceData(prefix, node.length - prefix, displayed.slice(prefix));
    }
    const size = Math.min(content.size, bounds.height),
      font = `${slot.weight ?? (slot.bold ? 'bold' : 'normal')} ${size}px ${family ?? 'serif'}`;
    this.measure.font = font;
    this.measure.fontKerning = 'none';
    const fullLines = Array.from({length: content.lines}, () => '');
    const lineBounds = fullLines.map(() => ({left: Infinity, right: -Infinity, top: Infinity}));
    const firstLine = Math.min(...slot.glyphs.map((g) => g.line));
    for (const g of slot.glyphs) {
      const line = g.line - firstLine;
      fullLines[line] += g.text ?? '';
      lineBounds[line]!.left = Math.min(lineBounds[line]!.left, g.x);
      lineBounds[line]!.right = Math.max(lineBounds[line]!.right, g.x + g.width);
      lineBounds[line]!.top = Math.min(lineBounds[line]!.top, g.y);
    }
    const browserWidths = fullLines.map((line) => this.measure.measureText(line).width);
    // A declared stretch reproduces native condensed glyphs and their pitch: CSS spacing
    // precedes scaleX, so each advance is stretch * (browser advance + spacing). The first
    // row's glyph step anchors the pitch, as it anchors the fallback compression below.
    let spacing = 0;
    const stretch = slot.vertical ? undefined : slot.stretch;
    if (stretch !== undefined && stretch > 0) {
      const row = slot.glyphs.filter((g) => g.line === firstLine && g.text),
        count = row.reduce((n, g) => n + Array.from(g.text!).length, 0);
      if (row.length > 1 && count > 1 && browserWidths[0]) {
        const pitch = (row.at(-1)!.x - row[0]!.x) / (count - Array.from(row.at(-1)!.text!).length);
        spacing = Math.max(
          pitch / stretch - browserWidths[0] / count,
          -browserWidths[0] / count / 2,
        );
      }
    }
    const widths = browserWidths.map(
      (width, line) => width + spacing * Array.from(fullLines[line]!).length,
    );
    const measured = Math.max(1, ...widths),
      scale =
        stretch !== undefined && stretch > 0
          ? stretch
          : Math.min(
              1,
              ...(slot.explicitLines ? widths.slice(0, 1) : widths).flatMap((width, line) =>
                width ? [(lineBounds[line]!.right - lineBounds[line]!.left) / width] : [],
              ),
            );
    const positioned = lineBounds.flatMap((row, line) =>
        Number.isFinite(row.top) ? [{line, top: row.top}] : [],
      ),
      firstPosition = positioned[0]!,
      lastPosition = positioned.at(-1)!,
      lineHeight =
        positioned.length > 1
          ? (lastPosition.top - firstPosition.top) / (lastPosition.line - firstPosition.line)
          : size;
    // The first row can hang to the left of subsequent rows (dialogue quotes).
    // text-indent preserves that offset; the float reserves the unused right
    // edge without splitting the Text node into independent visual rows.
    // Leave a small allowance for CSS subpixel rounding of measured advances.
    const origin = lineBounds.slice(1).find((line) => Number.isFinite(line.left))?.left ?? bounds.x,
      indent = (lineBounds[0]!.left - origin) / scale,
      wrapWidth =
        Math.max(1, ...widths.map((width, line) => width + (line === 0 ? indent : 0))) + 1 / 16;
    const edge = widths.flatMap((width, line) => {
      const x = width ? width + (line === 0 ? indent : 0) + 1 / 16 : 0;
      return [`${x}px ${line * lineHeight}px`, `${x}px ${(line + 1) * lineHeight}px`];
    });
    const shape = `polygon(${wrapWidth}px 0,${edge.join(',')},${wrapWidth}px ${content.lines * lineHeight}px)`;
    box.style.cssText = `position:absolute;left:${clip.x}px;top:${clip.y}px;width:${clip.width}px;height:${clip.height}px;overflow:hidden;pointer-events:none;z-index:${z}`;
    let filter = '';
    const outline = content.outline;
    if ((family && atlasTint) || content.shadows.length || outline) {
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
          outline ?? null,
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
        const edgeX = (outline?.radiusX ?? 0) / scale,
          edgeY = outline?.radiusY ?? 0;
        const minX = Math.min(0, ...content.shadows.map((s) => s.x)) / scale - edgeX,
          minY = Math.min(0, ...content.shadows.map((s) => s.y)) - edgeY,
          maxX = Math.max(0, ...content.shadows.map((s) => s.x)) / scale + edgeX,
          maxY = Math.max(0, ...content.shadows.map((s) => s.y)) + edgeY;
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
        if (outline) {
          // A native edge surrounds the ink by its radii; dilation of the browser
          // glyph's alpha is the equivalent shape at the browser's glyph outline.
          const columns = outline.radiusX * 2 + 1,
            rows = outline.radiusY * 2 + 1;
          if (outline.weights?.length === columns * rows)
            // Native edges sum weighted coverage and clamp; filter results clamp the same way.
            // Kernel cells are native pixels, so their x spacing undoes the text's scaleX.
            primitive('feConvolveMatrix', {
              in: 'SourceAlpha',
              order: `${columns} ${rows}`,
              kernelMatrix: outline.weights.join(' '),
              divisor: 1,
              targetX: outline.radiusX,
              targetY: outline.radiusY,
              edgeMode: 'none',
              kernelUnitLength: `${1 / scale} 1`,
              result: 'edge-shape',
            });
          else
            primitive('feMorphology', {
              in: 'SourceAlpha',
              operator: 'dilate',
              radius: `${edgeX} ${edgeY}`,
              result: 'edge-shape',
            });
          primitive('feFlood', {
            'flood-color': `#${(outline.color & 0xffffff).toString(16).padStart(6, '0')}`,
            'flood-opacity': Math.max(0, Math.min(255, outline.alpha)) / 255,
            result: 'edge-color',
          });
          primitive('feComposite', {
            in: 'edge-color',
            in2: 'edge-shape',
            operator: 'in',
            result: 'edge',
          });
        }
        const merge = primitive('feMerge', {});
        for (const name of [
          ...content.shadows.map((_, i) => `shadow-${i}`),
          ...(outline ? ['edge'] : []),
          'ink',
        ]) {
          const e = document.createElementNS(ns, 'feMergeNode');
          e.setAttribute('in', name);
          merge.append(e);
        }
        nodes.tint.key = key;
      }
      filter = `filter:url(#${nodes.tint.id});`;
    }
    text.style.cssText = `position:absolute;display:block;left:${origin - clip.x}px;top:${bounds.y - clip.y - (lineHeight - size) / 2}px;width:${wrapWidth}px;text-indent:${indent}px;--text-wrap-height:${content.lines * lineHeight}px;--text-wrap-shape:${shape};white-space:${slot.explicitLines ? 'pre' : 'break-spaces'};word-break:break-all;line-break:anywhere;hyphens:none;font:${font};font-kerning:none;font-variant-ligatures:none;letter-spacing:${spacing}px;${filter}line-height:${lineHeight}px;color:#${(content.color & 0xffffff).toString(16).padStart(6, '0')};opacity:${filter ? 1 : Math.min(255, content.alpha) / 255};transform:scaleX(${scale});transform-origin:0 0;user-select:${interactive ? 'text' : 'none'};-webkit-user-select:${interactive ? 'text' : 'none'};pointer-events:${interactive ? 'auto' : 'none'};cursor:${interactive ? 'text' : 'default'};outline:none`;
    // Reveal alpha belongs to glyphs, not paragraph identity. Custom highlight
    // ranges preserve that alpha without fragmenting text or changing wrapping.
    if (nodes.ink) this.clearInk(nodes.ink);
    if (
      typeof CSS !== 'undefined' &&
      CSS.highlights &&
      typeof Highlight !== 'undefined' &&
      slot.glyphs.some((g) => g.alpha > 0 && g.alpha < content.alpha)
    ) {
      if (!nodes.ink) {
        const style = document.createElement('style');
        box.append(style);
        nodes.ink = {style, names: []};
      }
      const rules: string[] = [];
      let offset = 0,
        previousLine = firstLine;
      for (const g of slot.glyphs) {
        if (slot.explicitLines) offset = Math.min(node.length, offset + g.line - previousLine);
        previousLine = g.line;
        const length = g.alpha > 0 ? (g.text?.length ?? 0) : Array.from(g.text ?? '').length,
          end = Math.min(node.length, offset + length);
        if (g.alpha > 0 && g.alpha < content.alpha && end > offset) {
          const range = document.createRange(),
            name = `game-ink-${++nextInk}`;
          range.setStart(node, offset);
          range.setEnd(node, end);
          CSS.highlights.set(name, new Highlight(range));
          nodes.ink.names.push(name);
          const c = content.color;
          rules.push(
            `.game-glyph-slots [data-game-text]::highlight(${name}){color:rgb(${(c >>> 16) & 255} ${(c >>> 8) & 255} ${c & 255}/${g.alpha / content.alpha})}`,
          );
        }
        offset = end;
      }
      nodes.ink.style.textContent = rules.join('\n');
    }
    text.className = slot.vertical
      ? 'vertical-game-text'
      : slot.explicitLines
        ? 'native-lines-game-text'
        : '';
    if (slot.vertical) {
      text.style.writingMode = 'vertical-rl';
      text.style.textOrientation = 'mixed';
      text.style.whiteSpace = 'pre';
      text.style.width = `${bounds.width}px`;
      text.style.height = `${Math.max(bounds.height, measured)}px`;
      text.style.top = `${bounds.y - clip.y}px`;
      text.style.lineHeight = `${bounds.width}px`;
      text.style.transform = `scaleY(${Math.min(1, bounds.height / measured)})`;
      text.style.filter = '';
      text.style.opacity = String(Math.min(255, content.alpha) / 255);
    }
    if (document.getSelection()?.containsNode(node, true) || nodes.highlights.length)
      this.queueSelection();
  }
  private clearInk(ink: InkHighlights): void {
    for (const name of ink.names) CSS.highlights.delete(name);
    ink.names.length = 0;
    ink.style.textContent = '';
  }
  /** Paint range rectangles as siblings of the filtered glyphs. Native selection
   * backgrounds are tinted with the font and can become black during animation. */
  private paintSelection(): void {
    const selection = document.getSelection(),
      layer = this.element.getBoundingClientRect(),
      sx = layer.width / this.width,
      sy = layer.height / this.height;
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
        if (n.ink) this.clearInk(n.ink);
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
    document.removeEventListener('copy', this.copy);
    cancelAnimationFrame(this.selectionFrame);
    this.clear();
    this.element.remove();
  }
}
