/**
 * Reader-selected DOM text styling. Disabled by default: DOM text then follows the game's
 * font, size, weight, color and native row geometry. Enabled styles replace those choices
 * for readability and deliberately give up exact glyph placement.
 */
export interface DomTextStyle {
  readonly enabled: boolean;
  /** CSS font-family list; empty keeps the game's font (after an uploaded font, if any). */
  readonly family: string;
  /** Multiplier of the native font size. */
  readonly scale: number;
  /** CSS weight, or null for the game's weight. */
  readonly weight: number | null;
  /** Keep the game's shadows and outlines. */
  readonly effects: boolean;
  /**
   * `fit` compresses rows to the native row width and pitch and clips to native bounds.
   * `natural` keeps browser advances and line spacing that fits the font, so text can
   * extend past the game's text window.
   */
  readonly layout: 'fit' | 'natural';
  /**
   * Reader stylesheet. Rules are scoped to DOM text layers and select slots by the classes
   * in `domTextClasses`; declarations without a selector apply to all text. Every declaration
   * takes precedence over the computed presentation.
   */
  readonly css: string;
}

export const defaultDomTextStyle: DomTextStyle = Object.freeze({
  enabled: false,
  family: '',
  scale: 1,
  weight: null,
  effects: true,
  layout: 'fit',
  css: '',
});

/** CSS family of the reader-supplied font file. */
export const domTextFontFamily = 'VnWebEngineReaderFont';

let style: DomTextStyle = defaultDomTextStyle;
let fontFace: FontFace | null = null;
let fontGeneration = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* One presentation must not prevent others from restyling. */
    }
  }
}

/** Parse and bound a stored or user-entered style. Unknown or invalid fields use defaults. */
export function normalizeDomTextStyle(value: unknown): DomTextStyle {
  const input = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  const d = defaultDomTextStyle;
  const number = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const scale = number(input.scale),
    weight = number(input.weight);
  return {
    enabled: typeof input.enabled === 'boolean' ? input.enabled : d.enabled,
    family: typeof input.family === 'string' ? input.family.trim() : d.family,
    scale: scale === null ? d.scale : Math.min(3, Math.max(0.25, scale)),
    weight: weight === null ? null : Math.min(1000, Math.max(1, Math.round(weight))),
    effects: typeof input.effects === 'boolean' ? input.effects : d.effects,
    layout: input.layout === 'natural' ? 'natural' : 'fit',
    css: typeof input.css === 'string' ? input.css : d.css,
  };
}

export function getDomTextStyle(): DomTextStyle {
  return style;
}

export function setDomTextStyle(value: Partial<DomTextStyle>): void {
  style = normalizeDomTextStyle({...style, ...value});
  adoptReaderSheet();
  notify();
}

/** Called after every style or reader-font change; returns an unsubscribe function. */
export function subscribeDomTextStyle(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether a reader-supplied font file is loaded. */
export function hasDomTextFont(): boolean {
  return fontFace !== null;
}

/**
 * Replace the reader-supplied font file; null removes it. Rejects, keeping the previous
 * font, when the browser cannot load the bytes.
 */
export async function setDomTextFont(bytes: Uint8Array | null): Promise<void> {
  const generation = ++fontGeneration;
  let next: FontFace | null = null;
  if (bytes !== null) {
    next = new FontFace(domTextFontFamily, bytes.slice().buffer);
    await next.load();
    if (generation !== fontGeneration) return;
  }
  if (fontFace) document.fonts.delete(fontFace);
  fontFace = next;
  if (next) document.fonts.add(next);
  notify();
}

/** The CSS family list for text whose game font is `gameFamily`. */
export function domTextFamily(current: DomTextStyle, gameFamily: string | undefined): string {
  const families = [
    ...(fontFace ? [JSON.stringify(domTextFontFamily)] : []),
    ...(current.family ? [current.family] : []),
  ];
  if (families.length === 0) return gameFamily ?? 'serif';
  // The game's face still supplies characters the chosen fonts lack (e.g. private-use glyphs).
  return [...families, ...(gameFamily ? [gameFamily] : []), 'serif'].join(', ');
}

/** Whether the style replaces the game's font family. */
export function replacesDomTextFamily(current: DomTextStyle): boolean {
  return current.enabled && (fontFace !== null || current.family !== '');
}

/**
 * Classes on every DOM text element (the `[data-game-text]` span), for reader stylesheets.
 * Engines add their own: see `GlyphSlot.classes`.
 */
export const domTextClasses = {
  text: 'game-text',
  horizontal: 'game-text-horizontal',
  vertical: 'game-text-vertical',
  multiline: 'game-text-multiline',
  inert: 'game-text-inert',
} as const;

let readerSheet: {css: string; sheet: CSSStyleSheet | null} | null = null;

/** Every style declaration in `rules`, recursively through nested and grouping rules. */
function* declarations(rules: CSSRuleList): Generator<CSSStyleDeclaration> {
  for (const rule of Array.from(rules)) {
    if ('style' in rule && rule.style instanceof CSSStyleDeclaration) yield rule.style;
    if ('cssRules' in rule && rule.cssRules instanceof CSSRuleList)
      yield* declarations(rule.cssRules);
  }
}

/**
 * The reader stylesheet for `css`, scoped to `.game-glyph-slots`, or null when it has no
 * rules or the browser cannot construct stylesheets. Text without a block is a declaration
 * list for all DOM text. Declarations become important, so rules win over the inline
 * presentation; the browser drops invalid rules and declarations.
 */
export function domTextStylesheet(css: string): CSSStyleSheet | null {
  if (readerSheet?.css === css) return readerSheet.sheet;
  let sheet: CSSStyleSheet | null = null;
  if (css.trim() && typeof CSSStyleSheet !== 'undefined') {
    const rules = css.includes('{') ? css : `.${domTextClasses.text}{${css}}`;
    try {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(`.game-glyph-slots{${rules}}`);
      for (const style of declarations(sheet.cssRules))
        for (const name of Array.from(style))
          style.setProperty(name, style.getPropertyValue(name), 'important');
      if (!Array.from(declarations(sheet.cssRules)).some((style) => style.length)) sheet = null;
    } catch {
      sheet = null;
    }
  }
  readerSheet = {css, sheet};
  return sheet;
}

let adopted: CSSStyleSheet | null = null;

/** Keeps the document's adopted reader stylesheet in step with the current style. */
function adoptReaderSheet(): void {
  if (typeof document === 'undefined' || !('adoptedStyleSheets' in document)) return;
  const next = style.enabled ? domTextStylesheet(style.css) : null;
  if (next === adopted) return;
  document.adoptedStyleSheets = [
    ...document.adoptedStyleSheets.filter((sheet) => sheet !== adopted),
    ...(next ? [next] : []),
  ];
  adopted = next;
}

/** Whether the current style has reader rules, which change layout the canvas cannot see. */
export function hasDomTextRules(current: DomTextStyle = style): boolean {
  return current.enabled && domTextStylesheet(current.css) !== null;
}
