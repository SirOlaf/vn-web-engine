import {slotText, type GlyphSlot, type TextGlyph} from './glyph-slots.js';
import {
  domTextClasses,
  domTextFamily,
  getDomTextStyle,
  hasDomTextRules,
  replacesDomTextFamily,
} from './dom-text-style.js';
let nextTint = 0;
let nextInk = 0;
interface InkHighlights {
  style: HTMLStyleElement;
  names: string[];
}
/**
 * Layout rules the text elements depend on, installed once per document: empty geometry
 * floated beside the text keeps native (or reflowed) visual rows out of the continuous Text
 * node.
 */
const layoutRules = `
.game-glyph-slots [data-game-text]::before {
  content: '';
  float: right;
  width: 100%;
  height: var(--text-wrap-height);
  shape-outside: var(--text-wrap-shape);
  pointer-events: none;
  user-select: none;
}
.game-glyph-slots [data-game-text].vertical-game-text::before {
  content: none;
}`;
const installedLayout = new WeakSet<Document>();
function installLayoutRules(): void {
  if (!document.head || installedLayout.has(document)) return;
  installedLayout.add(document);
  const style = document.createElement('style');
  style.dataset.gameTextLayout = '';
  style.textContent = layoutRules;
  // First in the head, so application and reader stylesheets can still override it.
  document.head.prepend(style);
}

/**
 * Characters that hang at a line end instead of beginning the next line when they fit:
 * the closing punctuation BGI's horizontal layout hangs (text-layout-horizontal.ts).
 */
const closingPunctuation = new Set([
  0x22, 0x27, 0x2c, 0x2e, 0x3f, 0x21, 0xff9e, 0xff9f, 0xff0c, 0xff0e, 0x3001, 0x3002, 0xff1f,
  0xff01, 0x201d, 0x309b, 0x309c, 0x5d, 0x7d, 0x29, 0xff09, 0x3015, 0xff3d, 0xff5d, 0x3009, 0x226b,
  0x300b, 0x300d, 0x300f, 0x3011, 0x30fd, 0x30fe, 0x309d, 0x309e, 0x3005, 0x30fb, 0x2025, 0x2026,
  0x2501, 0x2015, 0x2500, 0x30fc, 0xff5e, 0x266a, 0x3041, 0x3043, 0x3045, 0x3047, 0x3049, 0x3063,
  0x3083, 0x3085, 0x3087, 0x30a1, 0x30a3, 0x30a5, 0x30a7, 0x30a9, 0x30c3, 0x30e3, 0x30e5, 0x30e7,
  0x3000,
]);
const closes = (character: string) => closingPunctuation.has(character.codePointAt(0)!);

/**
 * Reflows native rows into lines of at most `width` (`firstWidth` for the first line).
 * `breaks[i]` keeps a deliberate break after row i; other rows join the next one. Lines
 * break between any characters, as the text's CSS allows. As in BGI's native layout,
 * closing punctuation hangs past the edge when its whole group (it and the closing
 * punctuation after it) fits within one of its advances beyond the edge; otherwise the
 * line breaks before it. Empty rows are kept.
 */
export function reflowTextRows(
  rows: readonly string[],
  breaks: readonly boolean[],
  advance: (character: string) => number,
  firstWidth: number,
  width: number,
): string[] {
  const lines: string[] = [];
  let line = '',
    used = 0;
  const available = () => (lines.length === 0 ? firstWidth : width);
  rows.forEach((row, index) => {
    const characters = Array.from(row);
    characters.forEach((character, position) => {
      const step = advance(character);
      if (line && used + step > available()) {
        let group = step;
        for (let next = position + 1; next < characters.length && closes(characters[next]!); next++)
          group += advance(characters[next]!);
        const hangs = closes(character) && used + group <= available() + step;
        if (!hangs) {
          lines.push(line);
          line = '';
          used = 0;
        }
      }
      line += character;
      used += step;
    });
    if (index === rows.length - 1 || breaks[index] || !row || !rows[index + 1]) {
      lines.push(line);
      line = '';
      used = 0;
    }
  });
  return lines;
}

export interface DomGlyphSlotsOptions {
  /**
   * The game keeps drawing its glyphs and the text is transparent over them, for selection
   * and dictionary lookups only. A reader style still shows the text in its own style.
   */
  readonly overlay?: boolean;
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
      /** Vertical native rows separate their visual rows with newline characters. */
      newlines?: boolean;
      ink?: InkHighlights;
      tint?: {filter: SVGFilterElement; id: string; key: string};
    }
  >();
  private readonly measure = document.createElement('canvas').getContext('2d')!;
  private probe: HTMLSpanElement | undefined;
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
    for (const {node, newlines} of this.nodes.values()) {
      if (!newlines || range.startContainer !== node || range.endContainer !== node) continue;
      // Native visual wraps are presentation-only, as in slotText's source string.
      event.clipboardData.setData('text/plain', range.toString().replaceAll('\n', ''));
      event.preventDefault();
      return;
    }
  };
  private readonly overlay: boolean;
  constructor(parent: HTMLElement, options: DomGlyphSlotsOptions = {}) {
    this.overlay = options.overlay ?? false;
    installLayoutRules();
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
    const custom = getDomTextStyle(),
      styled = custom.enabled;
    if (styled) {
      // A replacement family has ordinary glyphs coloured by CSS, not atlas ink to tint.
      if (replacesDomTextFamily(custom)) atlasTint = false;
      family = domTextFamily(custom, family);
    }
    const natural = styled && custom.layout === 'natural';
    // Transparent text over the game's own glyphs carries no colour or effects.
    const overlay = this.overlay && !styled;
    const slotContent = slotText(slot);
    const content =
      slotContent && styled
        ? {
            ...slotContent,
            shadows: custom.effects ? slotContent.shadows : [],
            outline: custom.effects ? slotContent.outline : undefined,
          }
        : slotContent && overlay
          ? {...slotContent, shadows: [], outline: undefined}
          : slotContent;
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
    // Horizontal native rows wrap through the float shape below, so the Text node holds the
    // source string: dictionary scanners and selections continue across rows. Vertical rows
    // have no shape wrap and keep newline separators.
    const newlines = slot.explicitLines && slot.vertical;
    nodes.newlines = newlines;
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
    // Stable hooks for reader stylesheets; see domTextClasses and GlyphSlot.classes.
    text.className = [
      domTextClasses.text,
      ...(slot.vertical
        ? [domTextClasses.vertical, 'vertical-game-text']
        : [domTextClasses.horizontal]),
      ...(content.lines > 1 ? [domTextClasses.multiline] : []),
      ...(interactive ? [] : [domTextClasses.inert]),
      ...(slot.classes ?? []),
    ].join(' ');
    text.dataset.fontSize = String(Math.round(Math.min(content.size, bounds.height)));
    // Update only the changed suffix, preserving the node and selections in the prefix.
    const displayed = newlines ? content.visualText : content.text;
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
    const size = Math.min(content.size, bounds.height) * (styled ? custom.scale : 1),
      weight = (styled ? custom.weight : null) ?? slot.weight ?? (slot.bold ? 'bold' : 'normal'),
      font = `${slot.italic ? 'italic ' : ''}${weight} ${size}px ${family ?? 'serif'}`;
    this.measure.font = font;
    this.measure.fontKerning = 'none';
    let fullLines = Array.from({length: content.lines}, () => '');
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
    // Natural layout keeps the browser font's own advances.
    const stretch = slot.vertical || natural ? undefined : slot.stretch;
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
    // Reader rules can change advances the canvas cannot see (letter or word spacing, font
    // features). Their rows are measured as laid out, so wrapping and fitting include them.
    const rules = styled && hasDomTextRules(custom);
    let widths =
      (rules && this.measureRows(text, fullLines, font, spacing, slot.vertical)) ||
      browserWidths.map((width, line) => width + spacing * Array.from(fullLines[line]!).length);
    const fit = Math.min(
        1,
        ...(slot.explicitLines ? widths.slice(0, 1) : widths).flatMap((width, line) =>
          width ? [(lineBounds[line]!.right - lineBounds[line]!.left) / width] : [],
        ),
      ),
      scale = natural
        ? 1
        : stretch !== undefined && stretch > 0
          ? // Reader rules can widen stretched rows past their native width; fit them again.
            rules
            ? Math.min(stretch, fit)
            : stretch
          : fit;
    const positioned = lineBounds.flatMap((row, line) =>
        Number.isFinite(row.top) ? [{line, top: row.top}] : [],
      ),
      firstPosition = positioned[0]!,
      lastPosition = positioned.at(-1)!,
      nativeLineHeight =
        positioned.length > 1
          ? (lastPosition.top - firstPosition.top) / (lastPosition.line - firstPosition.line)
          : size,
      // A larger reader font spaces its rows apart instead of overlapping them.
      lineHeight = natural ? Math.max(nativeLineHeight, size * 1.25) : nativeLineHeight;
    // The first row can hang to the left of subsequent rows (dialogue quotes).
    // text-indent preserves that offset; the float reserves the unused right
    // edge without splitting the Text node into independent visual rows.
    // Leave a small allowance for CSS subpixel rounding of measured advances. Native rows
    // accumulate per-glyph rounding of fractional spacing; an eighth of the font size still
    // admits no additional glyph.
    // Reflowed lines sum per-character advances, which likewise round differently in CSS.
    const allowance = slot.explicitLines || natural ? Math.max(1 / 16, size / 8) : 1 / 16;
    const origin = lineBounds.slice(1).find((line) => Number.isFinite(line.left))?.left ?? bounds.x,
      indent = (lineBounds[0]!.left - origin) / scale;
    if (natural && !slot.vertical) {
      // Natural spacing flows into as many lines as the text area needs. A wrapped
      // paragraph's widest native row is where the game wrapped, so it is the edge, and text
      // in the game's font reflows into the game's rows. A single row only shows where the
      // text ends; it may extend to the edge mirroring its left margin in the layer.
      // Rows ending more than two glyphs short of the widest row are deliberate breaks.
      const rights = lineBounds.map((row) => row.right),
        finite = rights.filter(Number.isFinite),
        widest = Math.max(...finite),
        right = finite.length > 1 ? widest : Math.max(widest, this.width - origin),
        glyph = content.size;
      const characters = [...new Set(fullLines.flatMap((row) => Array.from(row)))];
      const measuredCharacters = rules && this.measureRows(text, characters, font, 0);
      const advances = new Map(
        characters.map((character, index) => [
          character,
          measuredCharacters
            ? measuredCharacters[index]!
            : this.measure.measureText(character).width,
        ]),
      );
      const advance = (character: string) => advances.get(character) ?? size;
      fullLines = reflowTextRows(
        fullLines,
        rights.slice(0, -1).map((edge) => !Number.isFinite(edge) || edge < widest - glyph * 2),
        advance,
        right - origin - indent,
        right - origin,
      );
      widths = fullLines.map((row) => Array.from(row).reduce((sum, c) => sum + advance(c), 0));
    }
    const lines = fullLines.length,
      measured = Math.max(1, ...widths),
      wrapWidth =
        Math.max(1, ...widths.map((width, line) => width + (line === 0 ? indent : 0))) + allowance;
    const edge = widths.flatMap((width, line) => {
      const x = width ? width + (line === 0 ? indent : 0) + allowance : 0;
      return [`${x}px ${line * lineHeight}px`, `${x}px ${(line + 1) * lineHeight}px`];
    });
    const shape = `polygon(${wrapWidth}px 0,${edge.join(',')},${wrapWidth}px ${lines * lineHeight}px)`;
    box.style.cssText = `position:absolute;left:${clip.x}px;top:${clip.y}px;width:${clip.width}px;height:${clip.height}px;overflow:${natural ? 'visible' : 'hidden'};pointer-events:none;z-index:${z}`;
    let filter = '';
    const outline = content.outline;
    if (!overlay && ((family && atlasTint) || content.shadows.length || outline)) {
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
      // Atlas glyph ink is white and takes the text color here. Browser-font glyphs already
      // have their CSS color, so their ink only carries the reveal alpha.
      const c = family && atlasTint ? content.color : 0xffffff,
        key = JSON.stringify([
          c,
          content.shadows,
          outline ?? null,
          content.alpha,
          scale,
          measured,
          indent,
          lineHeight,
          lines,
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
        // A hanging first-row indent places glyphs left of the element's origin.
        const minX = Math.min(0, indent, ...content.shadows.map((s) => s.x / scale)) - edgeX,
          minY = Math.min(0, ...content.shadows.map((s) => s.y)) - edgeY,
          maxX = Math.max(0, ...content.shadows.map((s) => s.x)) / scale + edgeX,
          maxY = Math.max(0, ...content.shadows.map((s) => s.y)) + edgeY;
        f.setAttribute('filterUnits', 'userSpaceOnUse');
        f.setAttribute('x', String(minX - 1));
        f.setAttribute('y', String(minY - 1));
        f.setAttribute('width', String(measured + maxX - minX + 2));
        f.setAttribute('height', String(lineHeight * lines + maxY - minY + 2));
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
    text.style.cssText = `position:absolute;display:block;left:${origin - clip.x}px;top:${bounds.y - clip.y - (lineHeight - size) / 2}px;width:${wrapWidth}px;text-indent:${indent}px;--text-wrap-height:${lines * lineHeight}px;--text-wrap-shape:${shape};white-space:${newlines ? 'pre' : 'break-spaces'};word-break:break-all;line-break:anywhere;hyphens:none;font:${font};font-kerning:none;font-variant-ligatures:none;letter-spacing:${spacing}px;${filter}line-height:${lineHeight}px;color:${overlay ? 'transparent' : `#${(content.color & 0xffffff).toString(16).padStart(6, '0')}`};opacity:${filter || overlay ? 1 : Math.min(255, content.alpha) / 255};transform:scaleX(${scale});transform-origin:0 0;user-select:${interactive ? 'text' : 'none'};-webkit-user-select:${interactive ? 'text' : 'none'};pointer-events:${interactive ? 'auto' : 'none'};cursor:${interactive ? 'text' : 'default'};outline:none`;
    // Reveal alpha and glyph colours belong to glyphs, not paragraph identity. Custom
    // highlight ranges preserve them without fragmenting text or changing wrapping.
    if (nodes.ink) this.clearInk(nodes.ink);
    const inked = (g: TextGlyph) =>
      g.alpha > 0 && (g.alpha < content.alpha || g.color !== content.color);
    if (
      !overlay &&
      typeof CSS !== 'undefined' &&
      CSS.highlights &&
      typeof Highlight !== 'undefined' &&
      slot.glyphs.some(inked)
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
        if (newlines) offset = Math.min(node.length, offset + g.line - previousLine);
        previousLine = g.line;
        const length = g.alpha > 0 ? (g.text?.length ?? 0) : Array.from(g.text ?? '').length,
          end = Math.min(node.length, offset + length);
        if (inked(g) && end > offset) {
          const range = document.createRange(),
            name = `game-ink-${++nextInk}`;
          range.setStart(node, offset);
          range.setEnd(node, end);
          CSS.highlights.set(name, new Highlight(range));
          nodes.ink.names.push(name);
          const c = g.color;
          rules.push(
            `.game-glyph-slots [data-game-text]::highlight(${name}){color:rgb(${(c >>> 16) & 255} ${(c >>> 8) & 255} ${c & 255}/${g.alpha / content.alpha})}`,
          );
        }
        offset = end;
      }
      nodes.ink.style.textContent = rules.join('\n');
    }
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
      text.style.opacity = overlay ? '1' : String(Math.min(255, content.alpha) / 255);
    }
    // Reader CSS is applied last so that it overrides every computed declaration.
    if (document.getSelection()?.containsNode(node, true) || nodes.highlights.length)
      this.queueSelection();
  }
  /**
   * Moves `followerId`'s box by the distance between `leaderId`'s native text end and where
   * its browser text ends. Restyled dialogue ends elsewhere than the native row; a control
   * drawn at the native end (a wait marker) follows it. Forces layout; call after both
   * slots are shown. The next `show` of the follower resets the offset.
   */
  follow(followerId: string, leaderId: string): void {
    const leader = this.nodes.get(leaderId),
      follower = this.nodes.get(followerId),
      last = this.buffers
        .get(leaderId)
        ?.filter((g) => g.alpha > 0 && g.text && g.width > 0 && g.height > 0)
        .at(-1);
    if (!leader || !follower || !last || leader.box.hidden || follower.box.hidden) return;
    const {node} = leader;
    if (!node.length) return;
    const end = node.length,
      start = end - (end > 1 && /[\udc00-\udfff]/.test(node.data[end - 1]!) ? 2 : 1),
      range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const rect = Array.from(range.getClientRects()).at(-1),
      layer = this.element.getBoundingClientRect(),
      sx = layer.width / this.width,
      sy = layer.height / this.height;
    if (!rect || !(sx > 0) || !(sy > 0)) return;
    const dx = (rect.right - layer.left) / sx - (last.x + last.width),
      dy = ((rect.top + rect.bottom) / 2 - layer.top) / sy - (last.y + last.height / 2);
    follower.box.style.translate = `${dx}px ${dy}px`;
    // A clipped follower must not be cut off by its native bounds after moving.
    follower.box.style.overflow = 'visible';
  }
  /**
   * Unscaled layout widths of `rows` in this layer; null when the layer is not rendered.
   * Forces layout, so it is used only when reader CSS affects advances.
   */
  private measureRows(
    text: HTMLSpanElement,
    rows: readonly string[],
    font: string,
    spacing: number,
    vertical = false,
  ): number[] | null {
    const layer = this.element.getBoundingClientRect(),
      scale = layer.width / this.width,
      box = text.parentElement;
    if (vertical || !box || !(scale > 0)) return null;
    // Same element, classes and ancestors as the text, so reader selectors match it.
    const probe = (this.probe ??= document.createElement('span'));
    probe.className = text.className;
    probe.lang = text.lang;
    probe.dataset.gameText = '';
    if (text.dataset.fontSize) probe.dataset.fontSize = text.dataset.fontSize;
    probe.style.cssText = `left:0;top:0;font:${font};font-kerning:none;font-variant-ligatures:none;letter-spacing:${spacing}px;--text-wrap-height:0px`;
    // Reader rules cannot move, wrap or hide the probe.
    for (const [name, value] of [
      ['position', 'absolute'],
      ['display', 'inline-block'],
      ['visibility', 'hidden'],
      ['white-space', 'pre'],
      ['transform', 'none'],
      ['width', 'auto'],
    ] as const)
      probe.style.setProperty(name, value, 'important');
    box.append(probe);
    try {
      return rows.map((row) => {
        probe.textContent = row;
        return row ? probe.getBoundingClientRect().width / scale : 0;
      });
    } finally {
      probe.remove();
    }
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
