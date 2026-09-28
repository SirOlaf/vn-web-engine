import {decodeCp932, isCp932LeadByte} from '../text.js';
import {compositeOver} from '../graphics/blend.js';
import {colorrefPixel, createSurface, type RScriptSurface} from '../graphics/pixels.js';
import {RScriptContainer, RScriptSprite} from '../graphics/sprite.js';

/** Rasterized glyph coverage in GetGlyphOutline GGO_GRAY8 levels (0..64). */
export interface GlyphCoverage {
  readonly width: number;
  readonly height: number;
  readonly levels: Uint8Array;
}

/**
 * Font backend (0x4568F0). `code` is a Shift-JIS character (lead byte in the high byte)
 * or a single byte. The returned cell is `size` square for double-byte characters and
 * `size / 2` wide otherwise, with the glyph placed at its GDI origin below the ascent.
 */
export interface GlyphRasterizer {
  rasterize(
    code: number,
    size: number,
    face: number,
    bold: boolean,
    italic: boolean,
  ): GlyphCoverage;
}

/** Colours selected by `^C` letters (0x459EC0), as COLORREF values. */
const NAMED_COLORS: Readonly<Record<string, number>> = {
  B: 0x2020ff,
  G: 0x7fdfa5,
  K: 0x000000,
  O: 0xfaa25a,
  P: 0xf8b2ef,
  R: 0xb73233,
  S: 0x79f1f2,
  V: 0xc187f6,
  W: 0xffffff,
  Y: 0xffdd00,
};

/** Characters that may hang past the line end (0x45AB40 class 1). */
const HANGING = new Set([
  0x20, 0x27, 0x22, 0x2c, 0x2e, 0x3f, 0x21, 0x29, 0x7d, 0x5d, 0x8140, 0x8141, 0x8142, 0x8143,
  0x8144, 0x8148, 0x8149, 0x815b, 0x8160, 0x8163, 0x816a, 0x816c, 0x816e, 0x8170, 0x8172, 0x8174,
  0x8176, 0x8178, 0x817a, 0x8166, 0x8168, 0x82c1, 0x829f, 0x82a1, 0x82a3, 0x82a5, 0x82a7, 0x82e1,
  0x82e3, 0x82e5, 0x8340, 0x8342, 0x8344, 0x8346, 0x8348, 0x8383, 0x8385, 0x8387, 0x213f, 0x3f21,
  0x2121,
]);
/** Opening brackets that move to the next line rather than end one (class 2). */
const OPENING = new Set([
  0x8165, 0x8167, 0x8169, 0x816b, 0x816d, 0x816f, 0x8171, 0x8173, 0x8175, 0x8177, 0x8179, 0x814a,
]);
/** Half-width pairs drawn in one full-width cell (little-endian "?!", "!?", "!!"). */
const PAIRS = new Set([0x213f, 0x3f21, 0x2121]);

export interface TextStyle {
  face: number;
  size: number;
  color: number;
  /** Palette for `^C0`..`^C9` (the APINI +440 COLORREFs). */
  palette: readonly number[];
  /** Drop shadow renderer selected by text style +444 (0x456C00). */
  shadow: boolean;
  /** Ticks between revealed glyphs; 0 reveals everything at once (+416). */
  speed: number;
  lineSpacing: number;
  charSpacing: number;
  indent: number;
  firstIndent: number;
  /** 0 left, 1 centre, 2 right (+438 via +428). */
  align: number;
  width: number;
  height: number;
  rubyFace: number;
  rubySize: number;
  rubyRaise: number;
}

/** A revealed glyph in block coordinates, for selectable browser text. */
export interface TextBlockGlyph {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The script started a new line here (`^N`) rather than the layout wrapping. */
  readonly newline: boolean;
}

interface Glyph {
  sprite: RScriptSprite;
  /** Decoded character(s): one, or the two of a half-width pair. */
  text: string;
  advance: number;
  height: number;
  newline: boolean;
  kinsoku: 0 | 1 | 2;
  delay: number;
  ruby: RScriptSprite[] | null;
  rubyEnd: number;
}

/**
 * Message text object (0x459520): parses script markup (0x459EC0), lays glyphs out
 * horizontally (0x45AF80), places ruby (0x461160) and reveals glyphs over timer ticks with
 * per-glyph fades (0x45BC80).
 */
export class RScriptTextBlock extends RScriptContainer {
  private glyphs: Glyph[] = [];
  private revealed = 0;
  private rubyStart: number | null = null;
  private newlineNext = false;
  fits = true;

  constructor(
    private readonly rasterizer: GlyphRasterizer,
    readonly capacity: number,
    public style: TextStyle,
  ) {
    super(style.width, style.height);
  }

  get length(): number {
    return this.glyphs.length;
  }
  get complete(): boolean {
    return this.revealed >= this.glyphs.length;
  }

  /** sub_459D10 */
  clear(): void {
    for (const glyph of this.glyphs) {
      this.remove(glyph.sprite);
      for (const sprite of glyph.ruby ?? []) this.remove(sprite);
    }
    this.glyphs = [];
    this.revealed = 0;
    this.rubyStart = null;
    this.newlineNext = false;
    this.animating = false;
  }

  /** 0x4566A0 (plain) and 0x456C00 (shadowed) glyph sprites. */
  private glyphSurface(
    code: number,
    size: number,
    face: number,
    bold: boolean,
    italic: boolean,
    color: number,
  ): RScriptSurface {
    const pair = PAIRS.has(code);
    const width = code < 0x100 ? size >> 1 : size;
    const cell = createSurface(width, size, 0xff000000);
    const pixel = colorrefPixel(color) & 0xffffff;
    const draw = (coverage: GlyphCoverage, offset: number): void => {
      for (let y = 0; y < Math.min(coverage.height, size); y++)
        for (let x = 0; x < coverage.width && x + offset < width; x++) {
          const v = coverage.levels[y * coverage.width + x]!;
          if (v)
            cell.data[y * width + x + offset] =
              (pixel | ((255 - Math.trunc((255 * v) / 65)) << 24)) >>> 0;
        }
    };
    if (pair) {
      draw(this.rasterizer.rasterize(code >>> 8, size, face, bold, italic), 0);
      draw(this.rasterizer.rasterize(code & 0xff, size, face, bold, italic), size >> 1);
    } else draw(this.rasterizer.rasterize(code, size, face, bold, italic), 0);
    if (!this.style.shadow) return cell;
    const dx = Math.trunc(width / 12),
      dy = Math.trunc(size / 12);
    const out = createSurface(width + dx, size + dy, 0xff000000);
    const shadow = {width, height: size, data: cell.data.map((p) => p & 0xff000000)};
    compositeOver(out, shadow, dx, dy);
    compositeOver(out, cell, 0, 0);
    return out;
  }

  private addGlyph(
    code: number,
    size: number,
    face: number,
    bold: boolean,
    italic: boolean,
    color: number,
    delay: number,
  ): void {
    if (this.glyphs.length >= this.capacity) return;
    const sprite = new RScriptSprite();
    sprite.setSurface(this.glyphSurface(code, size, face, bold, italic, color));
    this.add(sprite, 0);
    this.glyphs.push({
      sprite,
      text: decodeCp932(code > 0xff ? Uint8Array.of(code >>> 8, code & 0xff) : Uint8Array.of(code)),
      advance: code < 0x100 && !PAIRS.has(code) ? size >> 1 : size,
      height: size,
      newline: this.newlineNext,
      kinsoku: HANGING.has(code) ? 1 : OPENING.has(code) ? 2 : 0,
      delay,
      ruby: null,
      rubyEnd: 0,
    });
    this.newlineNext = false;
  }

  /** sub_461760: small glyphs over the base glyphs from the last `|` to the last glyph. */
  private addRuby(text: Uint8Array, color: number): void {
    const last = this.glyphs.length - 1;
    if (last < 0) return;
    const first = Math.min(this.rubyStart ?? last, last);
    this.rubyStart = null;
    const sprites: RScriptSprite[] = [];
    for (let i = 0; i < text.length;) {
      const double = isCp932LeadByte(text[i]!) && i + 1 < text.length;
      const code = double ? (text[i]! << 8) | text[i + 1]! : text[i]!;
      i += double ? 2 : 1;
      const sprite = new RScriptSprite();
      sprite.setSurface(
        this.glyphSurface(code, this.style.rubySize, this.style.rubyFace, false, false, color),
      );
      this.add(sprite, 0);
      sprites.push(sprite);
    }
    const base = this.glyphs[first]!;
    base.ruby = sprites;
    base.rubyEnd = last;
  }

  /** Appends script text and lays everything out again; false when it overflows. */
  append(text: Uint8Array): boolean {
    const style = this.style;
    let color = style.color,
      bold = false,
      italic = false,
      scale = 1,
      delay = style.speed;
    const size = (): number => {
      const base = style.size;
      return scale === 0
        ? base >> 1
        : scale === 1
          ? base
          : scale === 2
            ? Math.trunc((3 * base) / 2)
            : scale === 3
              ? 2 * base
              : (scale - 1) * base;
    };
    const glyph = (code: number): void =>
      this.addGlyph(code, size(), style.face, bold, italic, color, delay);
    for (let i = 0; i < text.length && text[i] !== 0;) {
      const byte = text[i]!;
      const next = text[i + 1] ?? 0;
      if (isCp932LeadByte(byte) && next) {
        glyph((byte << 8) | next);
        i += 2;
      } else if (PAIRS.has(byte | (next << 8))) {
        glyph((byte << 8) | next);
        i += 2;
      } else if (byte === 0x7c) {
        this.rubyStart = this.glyphs.length;
        i++;
      } else if (byte === 0x5b) {
        let end = i + 1;
        while (end < text.length && text[end] && text[end] !== 0x5d)
          end += isCp932LeadByte(text[end]!) ? 2 : 1;
        this.addRuby(text.subarray(i + 1, end), color);
        i = text[end] === 0x5d ? end + 1 : end;
      } else if (byte === 0x5e && next) {
        const argument = text[i + 2] ?? 0;
        i += 2;
        switch (String.fromCharCode(next).toUpperCase()) {
          case 'B':
            bold = !bold;
            break;
          case 'I':
            italic = !italic;
            break;
          case 'C': {
            const letter = String.fromCharCode(argument).toUpperCase();
            if (letter in NAMED_COLORS) color = NAMED_COLORS[letter]!;
            else if (argument >= 0x30 && argument <= 0x39)
              color = style.palette[argument - 0x30] ?? color;
            if (argument) i++;
            break;
          }
          case 'D':
            if (style.speed)
              delay = argument === 0x30 ? 0 : style.speed + 2 * (argument - 0x30) - 2;
            if (argument) i++;
            break;
          case 'F':
            if (argument) i++;
            break;
          case 'S':
            scale = argument - 0x30;
            if (argument) i++;
            break;
          case 'L':
            color = style.color;
            bold = italic = false;
            scale = 1;
            delay = style.speed;
            break;
          case 'N':
            this.newlineNext = true;
            break;
          case 'V':
            while (text[i] === 0x2d || (text[i]! >= 0x30 && text[i]! <= 0x39)) {
              glyph(text[i] === 0x2d ? 0x817c : text[i]! + 0x821f);
              i++;
            }
            break;
          case 'A':
          case 'G':
            // Inline pictures are unused by the supported titles; skip their number.
            while (text[i] === 0x2d || (text[i]! >= 0x30 && text[i]! <= 0x39)) i++;
            break;
          default:
            break;
        }
      } else {
        glyph(byte);
        i++;
      }
    }
    this.fits = this.layout();
    return this.fits;
  }

  /** Horizontal layout (0x45AF80); returns false when a line exceeds the area height. */
  private layout(): boolean {
    const {width, height, lineSpacing, charSpacing, indent, firstIndent, align, size} = this.style;
    const glyphs = this.glyphs;
    const firstLine = lineSpacing === 0 ? 1 : 0;
    let index = 0,
      y = lineSpacing,
      fits = true;
    while (index < glyphs.length) {
      const start = index;
      const left = indent + (y === firstLine ? firstIndent : 0);
      let x = left,
        hung = false;
      while (index < glyphs.length) {
        const glyph = glyphs[index]!;
        if (x + glyph.advance > width) {
          if (x === left && index === start) return false;
          if (glyph.kinsoku === 1 && !hung) hung = true;
          else {
            if (index > start + 1 && glyphs[index - 1]!.kinsoku === 2) index--;
            break;
          }
        }
        x += glyph.advance + charSpacing;
        index++;
        if (glyphs[index]?.newline) break;
      }
      let lineWidth = 0,
        lineHeight = 0;
      for (let i = start; i < index; i++) {
        lineWidth += glyphs[i]!.advance;
        lineHeight = Math.max(lineHeight, glyphs[i]!.height);
      }
      let cursor =
        left + (align === 1 ? (width - lineWidth) >> 1 : align === 2 ? width - lineWidth : 0);
      for (let i = start; i < index; i++) {
        const glyph = glyphs[i]!;
        glyph.sprite.setPosition(cursor, y + lineHeight - glyph.height);
        cursor += glyph.advance + charSpacing;
      }
      if (index >= glyphs.length) break;
      y += lineSpacing + lineHeight;
      if (y + size > height) fits = false;
    }
    for (let i = 0; i < glyphs.length; i++) this.placeRuby(i);
    return fits;
  }

  /** 0x461160 without the line-wrap split: spread over the base span, or centre if wider. */
  private placeRuby(index: number): void {
    const base = this.glyphs[index]!;
    if (!base.ruby?.length) return;
    const first = base.sprite,
      last = this.glyphs[base.rubyEnd]!;
    const span = last.sprite.x + last.advance - first.x;
    const total = base.ruby.reduce((n, s) => n + s.width, 0);
    const y = first.y - this.style.rubyRaise;
    if (total <= span) {
      const step = Math.trunc(span / base.ruby.length);
      let x = first.x + (step >> 1);
      for (const sprite of base.ruby) {
        sprite.setPosition(x - (sprite.width >> 1), y);
        x += step;
      }
    } else {
      let x = first.x - Math.trunc((total - span) / 2);
      for (const sprite of base.ruby) {
        sprite.setPosition(x, y);
        x += sprite.width;
      }
    }
  }

  /** The glyphs revealed so far, with their text and placement. */
  shownGlyphs(): TextBlockGlyph[] {
    const shown: TextBlockGlyph[] = [];
    for (const glyph of this.glyphs) {
      const {sprite} = glyph;
      if (!sprite.visible) continue;
      shown.push({
        text: glyph.text,
        x: sprite.x,
        y: sprite.y,
        width: glyph.advance,
        height: glyph.height,
        newline: glyph.newline,
      });
    }
    return shown;
  }

  /** Shows every glyph immediately (vtable +96 on a text object). */
  finishReveal(): void {
    this.finishStep();
    this.animating = false;
  }

  /** Begins revealing glyphs added since the last reveal. */
  startReveal(): void {
    this.frameDelay = 0;
    this.animating = true;
  }

  private showGlyph(glyph: Glyph): void {
    glyph.sprite.show(true);
    for (const sprite of glyph.ruby ?? []) sprite.show(true);
  }

  /** 0x45BC80: reveals glyphs, fading each in with blend mode 2 at step 64. */
  protected override step(): boolean {
    let running = false;
    while (this.revealed < this.glyphs.length) {
      const glyph = this.glyphs[this.revealed]!;
      this.showGlyph(glyph);
      if (glyph.delay) {
        glyph.sprite.startFade(2, 0, 64);
        glyph.sprite.animating = true;
      }
      this.revealed++;
      const next = this.glyphs[this.revealed];
      if (next?.delay) {
        this.frameDelay = next.delay - 1;
        running = true;
        break;
      }
    }
    return running;
  }

  /** vtable +96: completes the reveal immediately. */
  protected override finishStep(): void {
    while (this.revealed < this.glyphs.length) this.showGlyph(this.glyphs[this.revealed++]!);
    for (const glyph of this.glyphs) glyph.sprite.stopAnimation();
  }
}
