import type {AokanaBitmap} from './bitmap.js';
import {bitmapRead8, bitmapWrite32} from './bitmap-scalar.js';
import type {AokanaFontRecord} from './fonts.js';
import {recordAokanaBitmapText} from './bitmap-dom-text.js';
import {textByte} from './text.js';

type AokanaOutlineReader = (x: number, y: number) => number;
type AokanaOutlineContribution = (value: number, dx: number, dy: number) => number;

function buildOutlineWeightTable(radius: number): Uint32Array {
  const side = radius * 2 + 1;
  const table = new Uint32Array(side * side);
  let index = 0;
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      const square = (Math.imul(dx, dx) + Math.imul(dy, dy)) | 0;
      const distance = Math.sqrt(square) - radius;
      table[index++] = distance <= 0 ? 0x10000 : distance >= 1 ? 0 : Math.trunc(distance * 65536);
    }
  return table;
}

/** 0408c0's five separately allocated (2r+1)^2 Q16 tables for radii one through five. */
const outlineWeightTables: readonly Uint32Array[] = Array.from({length: 5}, (_, index) =>
  buildOutlineWeightTable(index + 1),
);

/** Module evaluation is the one-shot startup latch; callers borrow the five published tables. */
export function aokanaTextOutlineWeightTables(): readonly Uint32Array[] {
  return outlineWeightTables;
}

function drawOutlinePixels(
  destination: AokanaBitmap,
  sourceWidth: number,
  sourceHeight: number,
  read: AokanaOutlineReader,
  radiusX: number,
  radiusY: number,
  color: number,
  contribution: AokanaOutlineContribution,
): void {
  const outputWidth = destination.width | 0;
  const outputHeight = destination.height | 0;
  sourceWidth |= 0;
  sourceHeight |= 0;
  radiusX |= 0;
  radiusY |= 0;
  color >>>= 0;
  for (let y = 0; y < outputHeight; y++)
    for (let x = 0; x < outputWidth; x++) {
      let sum = 0;
      for (let dy = -radiusY; dy <= radiusY; dy++) {
        const sourceY = (y + dy - radiusY) | 0;
        if (sourceY < 0 || sourceY >= sourceHeight) continue;
        for (let dx = -radiusX; dx <= radiusX; dx++) {
          const sourceX = (x + dx - radiusX) | 0;
          if (sourceX < 0 || sourceX >= sourceWidth) continue;
          sum = (sum + contribution(read(sourceX, sourceY), dx, dy)) >>> 0;
        }
      }
      const alpha = sum < 0x100 ? sum : 0xff;
      bitmapWrite32(
        destination,
        destination.offset + y * destination.stride + x * 4,
        ((alpha << 24) | color) >>> 0,
      );
    }
}

/** 03edb0 reads the font's actual cached byte glyph and applies its table/ellipse weights. */
export function drawAokanaCachedGlyphOutline(
  destination: AokanaBitmap,
  character: number,
  font: AokanaFontRecord,
  radiusX: number,
  radiusY: number,
  color: number,
): void {
  const raster = font.raster;
  if (raster === null) throw new Error('Aokana text outline reads an uninitialized ordinary font');
  const glyph = raster.glyph(character);
  const geometry = raster.geometry;
  if (destination.format !== 2) return;
  radiusX |= 0;
  radiusY |= 0;
  const useTable = radiusX === radiusY && radiusX >>> 0 <= 5 && radiusY >>> 0 <= 5;
  const table = useTable ? outlineWeightTables[(radiusY - 1) >>> 0] : undefined;
  const side = (radiusY * 2 + 1) | 0;
  drawOutlinePixels(
    destination,
    geometry.width,
    geometry.height,
    (x, y) => textByte(glyph.pixels, y * geometry.stride + x),
    radiusX,
    radiusY,
    color,
    useTable
      ? (value, dx, dy) =>
          Math.imul(value, table![Math.imul((dy + radiusY) | 0, side) + ((dx + radiusX) | 0)]!) >>>
          16
      : (value, dx, dy) => {
          const scaledX = (dx * radiusY) / radiusX;
          const distance = Math.sqrt(scaledX * scaledX + (Math.imul(dy, dy) | 0)) - radiusY;
          return distance <= 0 ? value : distance >= 1 ? 0 : Math.trunc(value * distance);
        },
  );
  recordAokanaBitmapText(destination, '', {
    size: raster.geometry.size,
    family: raster.face.cssFamily,
    color,
    decorative: true,
  });
}

/** 0723d0's custom branches sum either format-three bytes or a fitted RGBA alpha channel. */
export function drawAokanaByteMaskOutline(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  radiusX: number,
  radiusY: number,
  color: number,
  channel = 0,
): void {
  if (destination.format !== 2) return;
  drawOutlinePixels(
    destination,
    source.width,
    source.height,
    (x, y) =>
      bitmapRead8(source, source.offset + y * source.stride + x * source.bytesPerPixel + channel),
    radiusX,
    radiusY,
    color,
    (value) => value,
  );
  recordAokanaBitmapText(destination, '', {decorative: true, color});
}
