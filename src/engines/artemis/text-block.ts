import {artemisRevision} from './revision.js';

export interface ArtemisTextBlockStyle {
  readonly size: number;
  readonly shadow: number;
  readonly outline: number;
  readonly rubysize: number;
  readonly rubyshadow: number;
  readonly rubyoutline: number;
  readonly spacetop: number;
  readonly spacemiddle: number;
  readonly spacebottom: number;
  readonly kerning: number;
  readonly rubykerning: number;
}
export interface ArtemisBlockGlyph<T> {
  readonly glyph: T;
  /** Native painted surface advance before this stream's kerning. */
  readonly advance: number;
}
export interface ArtemisPositionedGlyph<T> extends ArtemisBlockGlyph<T> {
  readonly x: number;
  readonly y: number;
}
export interface ArtemisTextBlock<T> {
  readonly width: number;
  readonly height: number;
  readonly main: readonly ArtemisPositionedGlyph<T>[];
  readonly ruby: readonly ArtemisPositionedGlyph<T>[];
}
const f = Math.fround;
const add = (a: number, b: number) => f(a + b);
const subtract = (a: number, b: number) => f(a - b);
const u = (value: number) => f(value >>> 0);
/** 1971e0 block stream placement and reserved ruby/main line height. Glyph creation,
 * fonts, display transforms and resource lifetime remain owned by the text layer.
 */
export function layoutArtemisTextBlock<T>(
  hash: string,
  main: readonly ArtemisBlockGlyph<T>[],
  ruby: readonly ArtemisBlockGlyph<T>[],
  style: ArtemisTextBlockStyle,
): ArtemisTextBlock<T> {
  artemisRevision(hash);
  for (const value of [
    style.size,
    style.shadow,
    style.outline,
    style.rubysize,
    style.rubyshadow,
    style.rubyoutline,
  ])
    if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff)
      throw Error('Unsupported Artemis text block integer');
  for (const value of [
    style.spacetop,
    style.spacemiddle,
    style.spacebottom,
    style.kerning,
    style.rubykerning,
  ])
    if (!Number.isFinite(value) || !Number.isFinite(f(value)))
      throw Error('Unsupported Artemis text block spacing');
  if (main.length + ruby.length > 10000) throw Error('Artemis text block glyph budget exceeded');
  if ((!style.size && main.length) || (!style.rubysize && ruby.length))
    throw Error('Artemis zero-size stream must not create glyphs');
  let mainY = add(u(style.rubysize), f(style.spacetop));
  mainY = add(mainY, u(style.rubyshadow));
  mainY = add(mainY, u((style.rubyoutline * 2) | 0));
  mainY = add(mainY, f(style.spacemiddle));
  let height = add(mainY, u(style.size));
  height = add(height, u(style.shadow));
  height = add(height, u((style.outline * 2) | 0));
  height = add(height, f(style.spacebottom));
  const positioned = (stream: readonly ArtemisBlockGlyph<T>[], kerning: number, y: number) =>
    stream.map(({glyph, advance}) => {
      if (!Number.isFinite(advance) || !Number.isFinite(f(advance)))
        throw Error('Unsupported Artemis glyph advance');
      return {glyph, advance: f(advance) > 0 ? add(f(advance), f(kerning)) : 0, x: 0, y};
    });
  const body = positioned(main, style.kerning, mainY),
    annotation = positioned(ruby, style.rubykerning, f(style.spacetop));
  const total = (stream: readonly ArtemisBlockGlyph<T>[]) =>
    stream.reduce((width, glyph) => add(width, glyph.advance), 0);
  const bodyTotal = total(body),
    rubyTotal = total(annotation),
    bodyNet = subtract(bodyTotal, body.length ? f(style.kerning) : 0),
    rubyNet = subtract(rubyTotal, annotation.length ? f(style.rubykerning) : 0);
  const position = (stream: ArtemisPositionedGlyph<T>[], gap: number) => {
    let x = gap;
    for (const glyph of stream) {
      Object.assign(glyph, {x});
      x = add(add(x, glyph.advance), gap);
    }
  };
  let width: number;
  if (rubyNet <= bodyNet) {
    width = bodyTotal;
    position(body, 0);
    position(
      annotation,
      rubyNet < bodyNet ? f(subtract(bodyNet, rubyNet) / f(annotation.length + 1)) : 0,
    );
  } else {
    width = rubyTotal;
    position(annotation, 0);
    position(body, f(subtract(rubyNet, bodyNet) / f(body.length + 1)));
  }
  return Object.freeze({
    width,
    height,
    main: Object.freeze(body.map((glyph) => Object.freeze(glyph))),
    ruby: Object.freeze(annotation.map((glyph) => Object.freeze(glyph))),
  });
}
