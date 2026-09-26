import type {BurikoSurfaces} from './surfaces.js';
import {burikoBitmapRectangle, cropBurikoBitmap} from './bitmap.js';
import {clearBurikoBitmap} from './bitmap-copy.js';
import {stretchBurikoBitmapCubic} from './bitmap-cubic.js';

/** 031570 followed by floor/CVTTSD2SI, with the native 2^-14 snapping tolerance. */
function margin(value: number): number {
  const floor = Math.floor(value),
    fraction = value - floor;
  const snapped =
    fraction >= 1 - 2 ** -14 ? Math.ceil(value) : fraction <= 2 ** -14 ? floor : value;
  const result = Math.floor(snapped);
  return Number.isFinite(result) && result >= -0x80000000 && result < 0x80000000
    ? result | 0
    : -0x80000000;
}

/** 0329A0 clears both bars before cropping, then uses the cropped destination pivot. */
export function fitBurikoSurfaceAspect(
  surfaces: BurikoSurfaces,
  destinationIndex: number,
  sourceIndex: number,
): 0 | 0x80000009 | 0x8000000a {
  const destination = surfaces.snapshot(destinationIndex);
  if (destination === null) return 0x80000009;
  const source = surfaces.snapshot(sourceIndex);
  if (source === null) return 0x8000000a;
  const width = destination.width >>> 0,
    height = destination.height >>> 0,
    sourceWidth = source.width >>> 0,
    sourceHeight = source.height >>> 0,
    ratioY = height / sourceHeight,
    ratioX = width / sourceWidth;
  // COMISD/SETC chooses the height ratio for an unordered comparison too.
  const vertical = ratioY < ratioX || Number.isNaN(ratioY) || Number.isNaN(ratioX);
  const ratio = vertical ? ratioY : ratioX,
    area = burikoBitmapRectangle(destination);
  if (vertical) {
    const border = margin((width - sourceWidth * ratio) * 0.5);
    clearBurikoBitmap(destination, {...area, right: (border - 1) | 0});
    clearBurikoBitmap(destination, {...area, left: (area.right - border + 1) | 0});
    area.left = border;
    area.right = (area.right - border) | 0;
  } else {
    const border = margin((height - sourceHeight * ratio) * 0.5);
    clearBurikoBitmap(destination, {...area, bottom: (border - 1) | 0});
    clearBurikoBitmap(destination, {...area, top: (area.bottom - border + 1) | 0});
    area.top = border;
    area.bottom = (area.bottom - border) | 0;
  }
  cropBurikoBitmap(destination, area);
  stretchBurikoBitmapCubic(
    surfaces.compositor,
    destination,
    Math.fround((destination.width >>> 0) * 0.5),
    Math.fround((destination.height >>> 0) * 0.5),
    source,
    Math.fround(sourceWidth * 0.5),
    Math.fround(sourceHeight * 0.5),
    Math.fround(ratio),
    Math.fround(ratio),
    true,
  );
  return 0;
}
