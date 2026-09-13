import type {AokanaBpPointer} from '../bp/memory.js';
import {
  allocateAokanaBitmap,
  fillAokanaBitmap16,
  fillAokanaBitmap32,
  type AokanaBitmap,
} from './bitmap.js';
import {AokanaBitmapCompositor} from './bitmap-compositor.js';
import {bitmapWrite16, bitmapWrite32} from './bitmap-scalar.js';
import {aokanaWideCharacter, type AokanaGlyph, type AokanaFontRaster} from './font-raster.js';
import {AokanaNativeFonts} from './fonts.js';
import {isNativePunctuation, textByte} from './text.js';

/** A caller may bind this field directly to its native DWORD output storage. */
export interface AokanaFontTextOutput {
  value: number;
}

function divide(numerator: number, denominator: number): number {
  numerator |= 0;
  denominator |= 0;
  if (denominator === 0 || (numerator === -2147483648 && denominator === -1))
    throw new RangeError('Aokana font layout native integer division fault');
  return Math.trunc(numerator / denominator);
}

/** 14003f5c0 copies native coverage into only the intersecting raster dimensions. */
export function rasterAokanaGlyph(
  bitmap: AokanaBitmap,
  raster: AokanaFontRaster,
  character: number,
  color: number,
): AokanaGlyph {
  const glyph = raster.glyph(character);
  const width = Math.min(bitmap.width >>> 0, raster.geometry.width >>> 0);
  const height = Math.min(bitmap.height >>> 0, raster.geometry.height >>> 0);
  if (bitmap.format !== 0 && bitmap.format !== 1 && bitmap.format !== 2) return glyph;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const coverage = textByte(glyph.pixels, y * raster.geometry.stride + x);
      const offset = bitmap.offset + y * bitmap.stride + x * bitmap.bytesPerPixel;
      if (bitmap.format === 2) bitmapWrite32(bitmap, offset, (coverage << 24) | (color & 0xffffff));
      else {
        const red = Math.imul(coverage, (color >>> 16) & 255);
        const green = Math.imul(coverage, (color >>> 8) & 255);
        const blue = Math.imul(coverage, color & 255);
        if (bitmap.format === 1)
          bitmapWrite32(
            bitmap,
            offset,
            ((red & 0xffff00) << 8) | (green & 0xffffff00) | (blue >>> 8),
          );
        else
          bitmapWrite16(
            bitmap,
            offset,
            ((((red >>> 1) & 0xfc1f) | (green >>> 6)) & 0xffe0) | (blue >>> 11),
          );
      }
    }
  return glyph;
}

function proportionalGlyph(bitmap: AokanaBitmap, glyph: AokanaGlyph, size: number): number {
  const glyphWidth = (glyph.right - glyph.left + 1) | 0;
  bitmap.width = Math.min(glyphWidth >>> 0, (bitmap.width - glyph.left) >>> 0);
  bitmap.offset += Math.imul(bitmap.bytesPerPixel, glyph.left) >>> 0;
  const index = divide(Math.imul(glyphWidth, 16), size);
  if (index >= 8) return 1;
  const padding = [4, 4, 4, 3, 3, 3, 3, 2][index];
  if (padding === undefined)
    throw new RangeError('Aokana proportional glyph spacing reads outside native stack table');
  return padding;
}

/** Native font rendering through actual browser glyphs and the executable's bitmap compositor. */
export class AokanaBitmapText {
  constructor(
    readonly fonts: AokanaNativeFonts,
    readonly compositor: AokanaBitmapCompositor,
  ) {}

  /** 140041b20 returns one after a clipped/erroring glyph; only an unknown font ID returns zero. */
  draw(
    destination: AokanaBitmap,
    output: AokanaFontTextOutput,
    x: number,
    y: number,
    source: AokanaBpPointer | null,
    fontId: number,
    color: number,
    mode: number,
    proportional: number,
    wrap: number,
    linePercent: number,
  ): 0 | 1 {
    const font = this.fonts.find(fontId);
    if (font === null) return 0;
    const scratch = allocateAokanaBitmap(
      Math.imul(font.size, 2),
      font.size,
      this.compositor.defaultFormat,
    );
    const advance = divide(Math.imul(font.widthPercent, font.size), 100);
    const lineGap = divide(Math.imul(font.size, linePercent), 100);
    if (source === null) throw new Error('Aokana font text decoder dereferences a null source');
    const text = this.fonts.text.decodeAuto(source);
    output.value = 0;
    let maximumWidth = 0;
    let lineCount = 1;
    let hangingPunctuation = false;
    let position = x | 0;
    y |= 0;
    for (let index = 0; index < text.length; index++) {
      const character = text.charCodeAt(index);
      if (character === 0) break;
      if (character === 10) {
        lineCount = (lineCount + 1) >>> 0;
        y = (y + lineGap + font.size) | 0;
        position = x | 0;
        hangingPunctuation = false;
        if (wrap === 0) {
          maximumWidth = Math.max(maximumWidth, output.value >>> 0);
          output.value = 0;
        }
        continue;
      }
      if (font.raster === null)
        throw new Error('Aokana font drawing reads glyph state after failed native initialization');
      const glyph = rasterAokanaGlyph(scratch, font.raster, character, color);
      const view = {...scratch};
      const padding = proportional === 0 ? 0 : proportionalGlyph(view, glyph, font.size);
      if (proportional === 0)
        view.width = aokanaWideCharacter(character) === 0 ? divide(advance, 2) : advance;
      if (
        wrap !== 0 &&
        (destination.width - advance) >>> 0 < (view.width + padding * 2 + position) >>> 0
      ) {
        if (hangingPunctuation || !isNativePunctuation(character)) {
          lineCount = (lineCount + 1) >>> 0;
          y = (y + lineGap + font.size) | 0;
          hangingPunctuation = false;
          position = x | 0;
        } else hangingPunctuation = true;
      }
      if (this.compositor.draw(destination, (padding + position) | 0, y, view, mode, 0) !== 0)
        break;
      position = (position + padding * 2 + view.width) | 0;
      output.value = wrap === 0 ? (output.value + padding * 2 + view.width) >>> 0 : lineCount;
    }
    scratch.storage?.release();
    if (wrap === 0 && output.value >>> 0 < maximumWidth) output.value = maximumWidth;
    return 1;
  }

  /** 1400415b0 formats at most sixteen bytes per row using its two fixed ASCII CRT formats. */
  drawHex(
    destination: AokanaBitmap,
    x: number,
    y: number,
    source: AokanaBpPointer | null,
    count: number,
    fontId: number,
    color: number,
  ): 0 {
    const font = this.fonts.find(fontId);
    if (font === null) return 0;
    const line = allocateAokanaBitmap(
      divide(Math.imul(font.size, 0x36), 2),
      font.size,
      destination.format,
    );
    let rows = (count + 15) | 0;
    rows = (rows + ((rows >> 31) & 15)) >> 4;
    let firstByte = 0;
    let offset = source?.offset ?? 0;
    count >>>= 0;
    while (rows !== 0) {
      rows = (rows - 1) | 0;
      if (line.format === 0) fillAokanaBitmap16(line, 1);
      else if (line.format === 1) fillAokanaBitmap32(line, 0);
      else if (line.format === 2) fillAokanaBitmap32(line, 0xa0000000);
      const length = (count | 0) < 16 ? count | 0 : 16;
      let bytes = '';
      for (let index = 0; index < length; index++) {
        if (source === null)
          throw new Error('Aokana hexadecimal font drawing dereferences a null source');
        bytes += textByte(source.bytes, offset++).toString(16).toUpperCase().padStart(2, '0') + ' ';
      }
      const row = new TextEncoder().encode(
        (firstByte >>> 0).toString(16).toUpperCase().padStart(4, '0') + ' : ' + bytes + '\0',
      );
      const output = {value: 0};
      this.draw(line, output, 0, 0, {bytes: row, offset: 0}, fontId, color, 0, 0, 0, 0);
      this.compositor.draw(destination, x, y, line, 0x80, 0);
      y = (y + font.size) | 0;
      firstByte = (firstByte + 16) | 0;
      count = (count - 16) >>> 0;
    }
    line.storage?.release();
    return 0;
  }
}
