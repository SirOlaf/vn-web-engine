import {BurikoNativeDisplayState, type BurikoNativeRectangle} from './display-state.js';

function cvtt32(value: number): number {
  return Number.isFinite(value) && value >= -2147483648 && value < 2147483648
    ? Math.trunc(value) | 0
    : -2147483648;
}

/** 1400b27b0 returns inclusive edges; odd aspect-fit margins retain the extra pixel. */
export function burikoDisplayViewport(display: BurikoNativeDisplayState): BurikoNativeRectangle {
  if (display.fullscreen === 0)
    return [0, 0, (display.requestedWidth - 1) | 0, (display.requestedHeight - 1) | 0];
  const [width, height] = display.adjustedDesktopSize();
  const mode = display.effectiveDisplayMode();
  if (mode === 1) return [0, 0, (width - 1) | 0, (height - 1) | 0];
  let x: number, y: number;
  if (mode === 0) {
    const scale = Math.min(height / display.logicalHeight, width / display.logicalWidth);
    x = ((width - cvtt32(display.logicalWidth * scale)) | 0) >> 1;
    y = ((height - cvtt32(display.logicalHeight * scale)) | 0) >> 1;
  } else if (mode === 2) {
    x = (width - display.logicalWidth) >>> 1;
    y = (height - display.logicalHeight) >>> 1;
  } else throw new Error('Buriko display viewport reads unwritten native rectangle edges');
  return [x | 0, y | 0, (width - x - 1) | 0, (height - y - 1) | 0];
}

/** 1400b2740 scales each DWORD after a wrapping multiply, with unsigned DIV. */
export function burikoDisplayScaleSize(
  display: BurikoNativeDisplayState,
  x: number,
  y: number,
): readonly [number, number] {
  const [left, top, right, bottom] = burikoDisplayViewport(display);
  const width = display.logicalWidth >>> 0,
    height = display.logicalHeight >>> 0;
  if (width === 0 || height === 0) throw new Error('Buriko display size scaling DIV by zero');
  return [
    Math.floor((Math.imul((right - left + 1) | 0, x) >>> 0) / width),
    Math.floor((Math.imul((bottom - top + 1) | 0, y) >>> 0) / height),
  ];
}

/** 1400b28d0 preserves the caller's inclusive/exclusive choice for each corner. */
export function burikoDisplayTransformRectangle(
  display: BurikoNativeDisplayState,
  rectangle: BurikoNativeRectangle,
): BurikoNativeRectangle {
  const first = display.transformPoint(rectangle[0], rectangle[1], 0);
  const last = display.transformPoint(rectangle[2], rectangle[3], 0);
  return [first[0], first[1], last[0], last[1]];
}
