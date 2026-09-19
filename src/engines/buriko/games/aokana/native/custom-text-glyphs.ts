import type {AokanaBpPointer} from '../bp/memory.js';
import {transformAokanaBitmap} from './bitmap-affine.js';
import {clearAokanaBitmap} from './bitmap-copy.js';
import {blendAokanaMaskColor} from './bitmap-mask-color.js';
import {reduceAokanaBitmapHalf} from './bitmap-reduce.js';
import {allocateAokanaBitmap, clipAokanaBitmapPair, type AokanaBitmap} from './bitmap.js';
import {rasterAokanaGlyph} from './font-bitmap.js';
import {drawAokanaByteMaskOutline, drawAokanaCachedGlyphOutline} from './font-outline.js';
import type {AokanaFontRecord} from './fonts.js';
import type {AokanaSurfaces} from './surfaces.js';
import {AokanaNativeText, isNativeCp932Lead, nativeCp932CharacterToWide, textByte} from './text.js';

export interface AokanaDrawnGlyph {
  readonly character: number;
  readonly fullWidth: number;
  readonly pixels: Uint8Array | null;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly abc: readonly [number, number, number];
  readonly wideExtent: number;
}

interface AokanaCustomGlyphRecord {
  readonly key: number;
  readonly bitmap: AokanaBitmap;
}

function signedDivide(numerator: number, denominator: number): number {
  numerator |= 0;
  denominator |= 0;
  if (denominator === 0 || (numerator === -0x80000000 && denominator === -1))
    throw new RangeError('Aokana custom glyph signed division fault');
  return Math.trunc(numerator / denominator) | 0;
}

function unsignedDivide(numerator: number, denominator: number): number {
  numerator >>>= 0;
  denominator >>>= 0;
  if (denominator === 0) throw new RangeError('Aokana custom glyph unsigned division fault');
  return Math.trunc(numerator / denominator) >>> 0;
}

/** 0f8780 accepts the two disjoint numeric ranges used by the custom-glyph codec. */
export function isAokanaCustomGlyphCode(value: number): boolean {
  value >>>= 0;
  return (value | 0) < 0
    ? ((value & 0x7fffffff) - 0xf001) >>> 0 <= 0x7fe
    : (value - 0xff01) >>> 0 <= 0xfe;
}

/** 0733b0 recognizes the F8-prefixed embedded forms before the CP932 decoder. */
export function readAokanaEmbeddedCharacter(
  text: AokanaNativeText,
  bytes: Uint8Array,
  offset: number,
): {value: number; length: number} | null {
  if (textByte(bytes, offset) !== 0xf8) return null;
  if (textByte(bytes, offset + 1) === 0x80)
    return {
      value: (textByte(bytes, offset + 2) << 8) | textByte(bytes, offset + 3),
      length: 4,
    };
  const character = text.readCharacter(bytes, offset + 1, 1);
  return {value: character.value, length: (character.length + 1) >>> 0};
}

/** 073200 substitutes recorded numeric codes only on the detector's CP932 path. */
export function decodeAokanaEmbeddedText(text: AokanaNativeText, source: AokanaBpPointer): string {
  if (text.detectEncoding(source.bytes, source.offset, false) !== 0) return text.decodeAuto(source);
  const encoded: number[] = [];
  const codes: number[] = [];
  let offset = source.offset;
  while (textByte(source.bytes, offset) !== 0) {
    const first = textByte(source.bytes, offset);
    if (isNativeCp932Lead(first)) {
      const embedded = readAokanaEmbeddedCharacter(text, source.bytes, offset);
      if (embedded !== null) {
        codes.push(embedded.value >>> 0);
        encoded.push(0x84, 0xb7);
        offset += embedded.length;
        continue;
      }
      if (first === 0xef || first === 0xff) {
        codes.push(((first === 0xef ? 0xef00 : 0xf000) | textByte(source.bytes, offset + 1)) >>> 0);
        encoded.push(0x84, 0xb7);
      } else encoded.push(first, textByte(source.bytes, offset + 1));
      offset += 2;
    } else {
      encoded.push(first);
      offset++;
    }
  }
  encoded.push(0);
  const decoded = text.decodeAuto({bytes: Uint8Array.from(encoded), offset: 0});
  let result = '';
  let codeIndex = 0;
  for (let index = 0; index < decoded.length; index++) {
    const unit = decoded.charCodeAt(index);
    result += String.fromCharCode(unit === 0x2528 ? codes[codeIndex++]! & 0xffff : unit);
  }
  return result;
}

/** The ordered map at 27ca70 owns bitmap copies shared by registration, layout and outline paths. */
export class AokanaCustomGlyphs {
  private readonly records: AokanaCustomGlyphRecord[] = [];

  constructor(readonly surfaces: AokanaSurfaces) {}

  get count(): number {
    return this.records.length;
  }

  private find(key: number): AokanaCustomGlyphRecord | null {
    key >>>= 0;
    return this.records.find((record) => record.key === key) ?? null;
  }

  private remove(key: number): void {
    key >>>= 0;
    const index = this.records.findIndex((record) => record.key === key);
    if (index < 0) return;
    this.records[index]!.bitmap.storage?.release();
    this.records.splice(index, 1);
  }

  /** 072f80 destroys every owned value before restoring the empty sentinel/count state. */
  clear(): void {
    for (const record of this.records) record.bitmap.storage?.release();
    this.records.length = 0;
  }

  /** A copied descriptor is borrowed; its backing remains owned by this map. */
  snapshot(character: number): AokanaBitmap | null {
    const record = this.find(character);
    return record === null ? null : {...record.bitmap};
  }

  /** 072bd0 and 072c30 perform an exact marked-key lookup after their common predicate. */
  height(character: number): number {
    return isAokanaCustomGlyphCode(character) ? (this.find(character)?.bitmap.height ?? 0) : 0;
  }

  width(character: number): number {
    return isAokanaCustomGlyphCode(character) ? (this.find(character)?.bitmap.width ?? 0) : 0;
  }

  /** 072d90 retains an equal-key bitmap and uses the distinct unmarked key on removal. */
  register(
    character: number,
    surface: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): number {
    let normalized = character >>> 0;
    if (isAokanaCustomGlyphCode(normalized))
      normalized = nativeCp932CharacterToWide(normalized) >>> 0;
    const key = (normalized | 0x80000000) >>> 0;
    if (!isAokanaCustomGlyphCode(key)) return 0x80000006;
    if (surface >>> 0 === 0xffffffff) {
      this.remove(normalized);
      return 0;
    }
    const source = this.surfaces.snapshot(surface);
    if (source === null) return 0x80000002;
    if (width >>> 0 === 0 || height >>> 0 === 0) return 0x80000007;
    // Native re-enters the removal path with the distinct, unmarked normalized key.
    this.remove(normalized);
    const bitmap = allocateAokanaBitmap(width, height, source.format);
    clearAokanaBitmap(bitmap);
    this.surfaces.compositor.draw(bitmap, -x | 0, -y | 0, source, 0x80, 0);
    if (this.find(key) === null) {
      this.records.push({key, bitmap});
      this.records.sort((first, second) => (first.key >>> 0) - (second.key >>> 0));
    } else bitmap.storage?.release();
    return 0;
  }

  /** B47d0 marks codes only in global UTF-8 mode before tail-calling registration. */
  registerForCurrentEncoding(
    character: number,
    surface: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): number {
    if (this.surfaces.fonts.text.mode === 1) character = (character | 0x80000000) >>> 0;
    return this.register(character, surface, x, y, width, height);
  }

  /** 072c90 appends up to 255 FF01-based atlas slices and clears only for count zero. */
  configureAtlas(count: number, surface: number): number {
    if (count >>> 0 > 255) return 0x80000001;
    if ((count | 0) <= 0) {
      this.clear();
      return 0;
    }
    const source = this.surfaces.snapshot(surface);
    if (source === null) return 0x80000002;
    const width = unsignedDivide(source.width, count);
    if ((source.width >>> 0) % (count >>> 0) !== 0) return 0x80000003;
    let x = 0;
    for (let index = 0; index < count; index++) {
      this.register(0xff01 + index, surface, x, 0, width, source.height);
      x = (x + width) | 0;
    }
    return 0;
  }

  /** 072810 selects the ordinary raster lower or the custom copy/fitting pipeline. */
  draw(
    destination: AokanaBitmap,
    character: number,
    font: AokanaFontRecord,
    color: number,
    fitting: number,
  ): AokanaDrawnGlyph {
    const key = (character | 0x80000000) >>> 0;
    if (!isAokanaCustomGlyphCode(key)) {
      if (font.raster === null)
        throw new Error('Aokana custom glyph lower reads an uninitialized ordinary font');
      const glyph = rasterAokanaGlyph(destination, font.raster, character, color);
      return {
        character: glyph.character,
        fullWidth: glyph.fullWidth,
        pixels: glyph.pixels,
        left: glyph.left,
        top: glyph.top,
        right: glyph.right,
        bottom: glyph.bottom,
        abc: glyph.abc,
        wideExtent: glyph.wideExtent,
      };
    }
    let height = this.height(key);
    let width = this.width(key);
    const record = this.find(key);
    if (record !== null) {
      if (fitting === 0) {
        const clipped = clipAokanaBitmapPair(destination, 0, 0, record.bitmap);
        if (clipped !== null) {
          if (clipped.source.format === 3)
            blendAokanaMaskColor(clipped.destination, clipped.source, color);
          else this.surfaces.compositor.composite(clipped.destination, clipped.source, 0, 0);
        }
      } else {
        let source = {...record.bitmap};
        let owned: AokanaBitmap | null = null;
        if (source.format === 3) {
          owned = allocateAokanaBitmap(source.width, source.height, destination.format);
          clearAokanaBitmap(owned);
          blendAokanaMaskColor(owned, source, color);
          source = {...owned};
        }
        const size = font.size | 0;
        const product = Math.imul(font.widthPercent, size) | 0;
        const scaledProduct = (product << 16) | 0;
        const destinationX = signedDivide(scaledProduct, 200);
        const destinationY = (size << 15) | 0;
        let sourceX = (source.width << 15) | 0;
        let sourceY = (source.height << 15) | 0;
        let scaleX = unsignedDivide(scaledProduct, Math.imul(source.width, 100));
        let scaleY = unsignedDivide(size << 16, source.height);
        if (scaleX < 0x8000 || scaleY < 0x8000) {
          const reduced = allocateAokanaBitmap(
            ((source.width + 1) >>> 1) | 0,
            ((source.height + 1) >>> 1) | 0,
            source.format,
          );
          reduceAokanaBitmapHalf(reduced, source);
          owned?.storage?.release();
          owned = reduced;
          source = {...reduced};
          sourceX >>= 1;
          sourceY >>= 1;
          scaleX = (scaleX * 2) >>> 0;
          scaleY = (scaleY * 2) >>> 0;
        }
        transformAokanaBitmap(
          this.surfaces.compositor,
          destination,
          source,
          {
            x: destinationX,
            y: destinationY,
            pivotX: sourceX,
            pivotY: sourceY,
            angle: 0,
            scaleX,
            scaleY,
          },
          0,
          1,
          true,
        );
        owned?.storage?.release();
        width = signedDivide((product + 50) | 0, 100);
        height = size;
      }
    }
    return {
      character: character >>> 0,
      fullWidth: 1,
      pixels: null,
      left: 0,
      top: 0,
      right: (width - 1) | 0,
      bottom: (height - 1) | 0,
      abc: [0, Math.fround(width), 0],
      wideExtent: 1,
    };
  }

  /** 0723d0 selects the cached ordinary outline or this same map's byte-mask branches. */
  outline(
    destination: AokanaBitmap,
    character: number,
    font: AokanaFontRecord,
    radiusX: number,
    radiusY: number,
    color: number,
    fitting: number,
  ): void {
    const key = (character | 0x80000000) >>> 0;
    if (!isAokanaCustomGlyphCode(key)) {
      drawAokanaCachedGlyphOutline(destination, character, font, radiusX, radiusY, color);
      return;
    }
    const record = this.find(key);
    if (record === null || record.bitmap.format !== 3 || destination.format !== 2) return;
    if (fitting === 0) {
      drawAokanaByteMaskOutline(destination, record.bitmap, radiusX, radiusY, color);
      return;
    }
    const scratch = allocateAokanaBitmap(destination.width, destination.height, destination.format);
    clearAokanaBitmap(scratch);
    const glyph = this.draw(scratch, character, font, 0, fitting);
    drawAokanaByteMaskOutline(
      destination,
      {
        ...scratch,
        width: (glyph.right + 1) | 0,
        height: (glyph.bottom + 1) | 0,
      },
      radiusX,
      radiusY,
      color,
      3,
    );
    scratch.storage?.release();
  }

  decode(source: AokanaBpPointer): string {
    return decodeAokanaEmbeddedText(this.surfaces.fonts.text, source);
  }
}
