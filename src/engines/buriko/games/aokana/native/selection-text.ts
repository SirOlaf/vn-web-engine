import type {AokanaBpPointer} from '../bp/memory.js';
import {allocateAokanaBitmap, type AokanaBitmapRectangle} from './bitmap.js';
import {clearAokanaBitmap} from './bitmap-copy.js';
import type {AokanaWindowDisplayObject} from './display-window.js';
import {AokanaBitmapText} from './font-bitmap.js';
import {textLength} from './text.js';

const divide = (value: number, divisor: number): number => {
  if (divisor === 0 || (value === -2147483648 && divisor === -1))
    throw new RangeError('Aokana selection text has an undefined native signed quotient');
  return Math.trunc(value / divisor) | 0;
};

/** 07D530: draw the actual item strings and retain their measured selection rectangles. */
export function drawAokanaSelectionText(
  window: AokanaWindowDisplayObject,
  items: readonly (AokanaBpPointer | null)[],
  columns: number,
  centered: number,
  color: number,
): AokanaBitmapRectangle[] {
  columns |= 0;
  const region = window.getTextRectangle(),
    width = (region.right - region.left + 1) | 0,
    columnWidth = divide(width, columns),
    half = divide(columnWidth, 2),
    left: number[] = [],
    centers: number[] = [];
  for (let column = 0, accumulated = 0; column < columns; column++) {
    left.push((region.left + divide(accumulated, columns)) | 0);
    centers.push((left[column]! + half) | 0);
    accumulated = (accumulated + width) | 0;
  }
  const fontId = window.fontId,
    size = window.fontSize,
    advance = window.textLineAdvance(),
    proportional = window.characterSpacing,
    colors = new Uint32Array(16),
    custom = window.getTextParameters(colors),
    surfaces = window.windowState.manager.surfaces,
    text = new AokanaBitmapText(surfaces.fonts, surfaces.compositor),
    rectangles: AokanaBitmapRectangle[] = [];
  window.clearText();
  for (let index = 0, column = 0; index < items.length; index++, column = (column + 1) % columns) {
    const source = items[index]!;
    if (source === null) throw new Error('Aokana selection renderer reads a null item string');
    const bitmap = allocateAokanaBitmap(Math.imul(Math.imul(textLength(source), size), 2), size, 1);
    clearAokanaBitmap(bitmap);
    const measured = {value: 0};
    const published = text.draw(
      bitmap,
      measured,
      0,
      0,
      source,
      fontId,
      custom !== 0 ? colors[index]! : color,
      0x80,
      proportional,
      0,
      0,
    );
    // 041B20 leaves native width scratch untouched on an unknown font; consume no invented width.
    if (published === 0)
      throw new Error('Aokana selection renderer consumes undefined glyph width');
    const x = centered === 0 ? left[column]! : (centers[column]! - (measured.value >>> 1)) | 0,
      y = (region.top + Math.imul(divide(index, columns), advance)) | 0;
    rectangles.push({
      left: x,
      top: y,
      right: (x + measured.value - 1) | 0,
      bottom: (y + size - 1) | 0,
    });
    // This scratch is never consumed: 067910 replaces it before final damage recording.
    const unusedDamage = {...region};
    window.drawTextBitmap(unusedDamage, x, y, bitmap, 0x80, 0);
    bitmap.storage?.release();
  }
  window.environment.damage.record(window.sortKey(), window.textBitmapRectangle());
  return rectangles;
}
