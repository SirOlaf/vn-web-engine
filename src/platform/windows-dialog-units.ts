/**
 * Dialog base units: the factors that turn dialog template units into pixels
 * (`MapDialogRect`: x × cx / 4, y × cy / 8) and `GetDialogBaseUnits`.
 *
 * Windows derives them from font metrics: cy is the font's `tmHeight`, cx the average width of
 * the Latin alphabet (`GdiGetCharDimensions`: extent of "A…Za…z" / 26, then (n + 1) / 2). A
 * browser has no GDI fonts, so these values come from the fonts of a Japanese Windows 8
 * system at 96 DPI: the system font is 8 × 16, and the dialog fonts (`MS Shell Dlg` maps to
 * MS UI Gothic) have no internal leading, so cy is the pixel height and cx half of it,
 * rounded up, as their half-width Latin glyphs give.
 */

export interface DialogBaseUnits {
  readonly cx: number;
  readonly cy: number;
}

/** `GetDialogBaseUnits`: the system font. */
export const SYSTEM_DIALOG_BASE_UNITS: DialogBaseUnits = {cx: 8, cy: 16};

/** The pixel height of a point size at 96 DPI (`-MulDiv(pt, 96, 72)` as a height). */
export function pointSizeToPixels(pointSize: number): number {
  return Math.floor((pointSize * 96 + 36) / 72);
}

/**
 * Base units of a dialog font (`DS_SETFONT`). A point size of 0x7fff (`DS_SHELLFONT` with the
 * message box font) selects the system message font, 9 points.
 */
export function dialogFontBaseUnits(_face: string, pointSize: number): DialogBaseUnits {
  const points = pointSize === 0x7fff ? 9 : pointSize;
  const cy = Math.max(1, pointSizeToPixels(points));
  return {cx: Math.max(1, Math.ceil(cy / 2)), cy};
}
