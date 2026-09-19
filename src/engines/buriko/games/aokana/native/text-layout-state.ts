import {AokanaNativeText, copyText, textLength} from './text.js';
import {AokanaRubyAnnotations} from './text-annotations.js';
import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import {AokanaSurfaces} from './surfaces.js';
import {allocateAokanaBitmap, type AokanaBitmap} from './bitmap.js';
import {terminatedNativeBytes} from './program-files.js';
import {AokanaCustomGlyphs} from './custom-text-glyphs.js';
import type {AokanaFontRecord} from './fonts.js';
import {
  buildAokanaHorizontalTextLayout,
  type AokanaHorizontalTextLayoutOptions,
  type AokanaHorizontalTextLayoutResult,
} from './text-layout-horizontal.js';

export interface AokanaTextFrameError {
  value: number;
}

export interface AokanaTextLinkRegion {
  readonly text: Uint8Array;
  readonly x: number;
  readonly y: number;
}

const emptyBitmap = (): AokanaBitmap => ({
  storage: null,
  offset: 0,
  stride: 0,
  width: 0,
  height: 0,
  format: 0,
  bytesPerPixel: 0,
});

/** Shared text-layout globals written by 078ab0, distinct from each window's font/cursor state. */
export class AokanaTextLayoutState {
  /** 1d2760 is the persistent registry; each layout call owns a separate annotation context. */
  readonly annotations: AokanaRubyAnnotations;
  readonly text: AokanaNativeText;
  /** 27ca70 is the one shared numeric glyph map used by registration and both layout directions. */
  readonly customGlyphs: AokanaCustomGlyphs;
  field1C9100 = 25;
  field1D1E48 = 0;
  field1C90EC = 40;
  field1C90E8 = 150;
  field1D1E4C = 0;
  /** 078f50, used by 0673f0's horizontal and vertical line-start predicate. */
  lineStartOffset = 0;

  readonly readingFontName = new Uint8Array(256);
  readingYOffset = 0;
  readingValue1C90F8 = 0xffffffff;
  readingValue1C90F4 = 0xffffffff;
  readingFontSize = 0;
  readingXOffset = 0;
  readingWidth = 0;

  field1C90F0 = 1;
  field1D1E54 = 0;
  field1C90FC = 65536;
  field1D27A0 = 0;
  field1D1E40 = 0;
  field1D27B0 = 0;
  field1D1DB8 = 0;
  field1D27A4 = 0;
  field1C90E0 = 1;
  field1D1DAC = 0;
  field1D1DBC = 0;
  field1D1D94 = 0;

  /** 1c9060 is the fixed Q16 side-bearing scale used by horizontal proportional layout. */
  proportionalSideBearing = 0x2aaa;
  /** 1c90e4 and 1d27a8 are shared, but each builder resets the latter from its input color. */
  linkColor = 0xffffffff;
  currentInlineColor = 0;
  /** 1d1dc0 and 1d1e20..2c provide the optional font selected while a link is open. */
  readonly alternateFontName = new Uint8Array(256);
  alternateFontSize = 0;
  alternateFontWidth = 0;
  alternateFontBold = 0;
  alternateFontItalic = 0;
  /** 1d1e50/1d1e60 retain at most sixteen encoded link positions from the latest build. */
  readonly linkRegions: AokanaTextLinkRegion[] = [];
  /** 1D1E58 is the bitmap-text caller's shared horizontal cursor pair. */
  readonly surfaceCursor = {x: 0, y: 0};
  /** 077bb0 publishes an opaque ID for the latest per-line extent vector when policy 80000009 is on. */
  readonly lineHeightLayouts = new Map<number, readonly number[]>();
  private nextLineHeightLayoutId = 0;
  missingGlyphHandler: ((character: number) => void) | null = null;

  /** 1d1d78/1d1da8 belong to animated window overlay zero, separately from custom glyphs. */
  overlayFrames: AokanaBitmap[] | null = null;
  overlayFrameCount = 0;
  overlayFrameInterval = 150;
  overlayPositionMode = 0;
  overlayPositionX = 0;
  overlayPositionY = 0;

  constructor(readonly surfaces: AokanaSurfaces) {
    this.text = surfaces.fonts.text;
    this.annotations = new AokanaRubyAnnotations(this.text);
    this.customGlyphs = new AokanaCustomGlyphs(surfaces);
  }

  /** B46f0 controls the same persistent registry used by 078e40 and text procedures. */
  setAnnotation(key: AokanaBpPointer | null, reading: AokanaBpPointer | null): 0 | 1 {
    if (key === null) {
      this.annotations.clear();
      return 1;
    }
    if (reading === null) return this.annotations.remove(key);
    this.annotations.add(key, reading);
    return 1;
  }

  /** 078ab0 validates before writing any field and substitutes one only for a zero second argument. */
  configure(a: number, b: number, c: number, d: number, e: number, f: number): number {
    if ((d - 25) >>> 0 > 75) return 0x80000001;
    if ((e | 0) < 0) return 0x80000002;
    this.field1C9100 = a >>> 0;
    this.field1D1E48 = c >>> 0;
    this.field1C90EC = d >>> 0;
    this.field1C90E8 = (b | 0) === 0 ? 1 : b >>> 0;
    this.field1D1E4C = f >>> 0;
    this.lineStartOffset = e >>> 0;
    return 0;
  }

  /** 0788b0 preserves the trailing name bytes on copy and publishes numeric fields in native order. */
  setReadingFont(
    name: AokanaBpPointer | null,
    size: number,
    width: number,
    x: number,
    y: number,
    value6: number,
    value7: number,
  ): number {
    if (name === null) this.readingFontName.fill(0);
    else {
      if (textLength(name) > 255) return 0x80000003;
      copyText({bytes: this.readingFontName, offset: 0}, name);
    }
    this.readingYOffset = y | 0;
    this.readingValue1C90F8 = value6 >>> 0;
    this.readingValue1C90F4 = value7 >>> 0;
    this.readingFontSize = size | 0;
    this.readingXOffset = x | 0;
    this.readingWidth = width | 0;
    return 0;
  }

  /** B46a0 resolves only the registered font name; it does not create a new raster record. */
  setRegisteredReadingFont(
    index: number,
    size: number,
    width: number,
    x: number,
    y: number,
    value6: number,
    value7: number,
  ): number {
    const name = this.surfaces.fonts.name(index);
    return this.setReadingFont(
      name === null ? null : {bytes: terminatedNativeBytes(name), offset: 0},
      size,
      width,
      x,
      y,
      value6,
      value7,
    );
  }

  /** 074d20 applies the shared size override before the percentage and minimum-four rules. */
  readingSize(fontSize: number): number {
    const size =
      this.readingFontSize > 0
        ? this.readingFontSize
        : Math.trunc(Math.imul(this.field1C90EC, fontSize) / 100);
    return Math.max(4, size);
  }

  resetLinkRegions(): void {
    this.linkRegions.length = 0;
  }

  addLinkRegion(text: string, x: number, y: number): boolean {
    if (this.linkRegions.length >= 16) return false;
    const encoded = this.text.encodeWide(text, 1),
      end = encoded.indexOf(0),
      length = Math.min(end < 0 ? encoded.length : end, 95);
    this.linkRegions.push({text: encoded.slice(0, length), x: x | 0, y: y | 0});
    return true;
  }

  publishLineHeightLayout(values: readonly number[]): number {
    this.nextLineHeightLayoutId = (this.nextLineHeightLayoutId + 1) | 0;
    const id = this.nextLineHeightLayoutId;
    this.lineHeightLayouts.set(
      id,
      values.map((value) => value >>> 0),
    );
    while (this.lineHeightLayouts.size > 16)
      this.lineHeightLayouts.delete(this.lineHeightLayouts.keys().next().value!);
    return id;
  }

  async buildHorizontalText(
    options: AokanaHorizontalTextLayoutOptions,
  ): Promise<AokanaHorizontalTextLayoutResult> {
    return buildAokanaHorizontalTextLayout(this, options);
  }

  /** 0789b0 retains raw DWORD selectors and the one self-assignment branch. */
  setPolicy(selector: number, value: number): number {
    value >>>= 0;
    switch (selector >>> 0) {
      case 0:
        this.field1C90F0 = value;
        break;
      case 0x80000000:
        this.field1D1E54 = value;
        break;
      case 0x80000001:
        if ((value | 0) < 0) return 0x80000008;
        this.field1C90FC = value;
        break;
      case 0x80000002:
        this.field1D27A0 = value;
        break;
      case 0x80000003:
        this.field1D1E40 = value;
        break;
      case 0x80000004:
        this.field1D27B0 = value;
        break;
      case 0x80000005:
        this.field1D1DB8 = value < 2 ? value : this.field1D1DB8;
        break;
      case 0x80000006:
        this.field1D27A4 = value;
        break;
      case 0x80000007:
        this.field1C90E0 = value;
        break;
      case 0x80000008:
        this.field1D1DAC = value;
        break;
      case 0x80000009:
        this.field1D1DBC = value;
        break;
      case 0x8000000a:
        this.field1D1D94 = value;
        break;
      default:
        return 0x80000007;
    }
    return 0;
  }

  /** 0723d0 reads the shared fitting flag while selecting ordinary or registered glyph data. */
  drawGlyphOutline(
    destination: AokanaBitmap,
    character: number,
    font: AokanaFontRecord,
    radiusX: number,
    radiusY: number,
    color: number,
  ): void {
    this.customGlyphs.outline(
      destination,
      character,
      font,
      radiusX,
      radiusY,
      color,
      this.field1D1D94,
    );
  }

  /** 072210 keeps already-cloned frames if a later surface or composite reports the native failure. */
  configureOverlayFrames(
    count: number,
    source: AokanaBpPointer | null,
    error: AokanaTextFrameError | null,
  ): 0 | 1 {
    if (this.overlayFrameCount > 0) {
      if (this.overlayFrames === null)
        throw new Error('Aokana text frame count has no descriptor array');
      for (let index = 0; index < this.overlayFrameCount; index++) {
        const frame = this.overlayFrames[index];
        if (frame === undefined)
          throw new RangeError('Aokana text frame index exceeds its descriptor array');
        frame.storage?.release();
      }
    }
    this.overlayFrameCount = count | 0;
    this.overlayFrames = null;
    if (this.overlayFrameCount <= 1) return 1;
    this.overlayFrames = Array.from({length: this.overlayFrameCount}, emptyBitmap);
    if (source === null) throw new Error('Aokana text frame configuration has no source ID array');
    const ids = pointerView(source);
    for (let index = 0; index < this.overlayFrameCount; index++) {
      const id = ids.getUint32(index * 4, true);
      if (id === 0xffffffff) continue;
      const bitmap = this.surfaces.snapshot(id);
      let result = 1;
      if (bitmap !== null) {
        const frame = allocateAokanaBitmap(bitmap.width, bitmap.height, 1);
        this.overlayFrames[index] = frame;
        result = this.surfaces.compositor.composite(frame, bitmap, 0x80, 0, true);
      }
      if (result === 1) {
        if (error === null) throw new Error('Aokana text frame failure has no source ID output');
        error.value = ids.getUint32(index * 4, true);
        return 0;
      }
    }
    return 1;
  }

  /** 0721f0 uses the same replacement path for clearing. */
  clearOverlayFrames(): void {
    this.configureOverlayFrames(0, null, null);
  }

  /** 0721b0 returns 80000008 even after a valid ordinary position update. */
  setOverlayPosition(mode: number, x: number, y: number): number {
    if (mode >>> 0 <= 4) {
      this.overlayPositionX = x | 0;
      this.overlayPositionY = y | 0;
    }
    this.overlayPositionMode = mode >>> 0 > 4 ? 0 : mode >>> 0;
    return 0x80000008;
  }
}
