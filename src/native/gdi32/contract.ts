import {defineNativeContract} from '../../platform/native-libraries.js';

/**
 * `gdi32.dll`: device contexts and the GDI objects libraries create and pass to windows
 * (bitmaps, DIB sections, brushes, stock objects). Handles are non-zero unsigned 32-bit
 * numbers. A DIB section's bits live in the process memory, so callers write pixels through
 * the address `CreateDIBSection` returns, as natively.
 */

/** `BITMAPINFOHEADER`/`BITMAPV5HEADER` members a DIB section uses. */
export interface DibHeader {
  width: number;
  /** Positive: bottom-up rows; negative: top-down. */
  height: number;
  bitCount: number;
  /** `BI_RGB` (0) or `BI_BITFIELDS` (3). */
  compression: number;
  redMask: number;
  greenMask: number;
  blueMask: number;
  alphaMask: number;
}

export const BI_RGB = 0;
export const BI_BITFIELDS = 3;
export const SRCCOPY = 0x00cc0020;
export const OPAQUE = 2;
export const TRANSPARENT = 1;
export const CLR_INVALID = 0xffffffff;
export const HGDI_ERROR = 0xffffffff;

// Stock objects.
export const WHITE_BRUSH = 0;
export const LTGRAY_BRUSH = 1;
export const GRAY_BRUSH = 2;
export const DKGRAY_BRUSH = 3;
export const BLACK_BRUSH = 4;
export const NULL_BRUSH = 5;
export const WHITE_PEN = 6;
export const BLACK_PEN = 7;
export const NULL_PEN = 8;
export const SYSTEM_FONT = 13;
export const DEFAULT_GUI_FONT = 17;

/** What `GetObjectW` tells of a bitmap (`BITMAP`). */
export interface BitmapInfo {
  readonly kind: 'bitmap';
  width: number;
  height: number;
  bitCount: number;
  /** Bytes per row (DWORD-aligned for DIBs, WORD-aligned for device bitmaps). */
  widthBytes: number;
  /** Address of the bits, 0 for device bitmaps without process-memory bits. */
  bits: number;
}

/** What `GetObjectW` tells of a brush (`LOGBRUSH`). */
export interface BrushInfo {
  readonly kind: 'brush';
  /** `BS_SOLID` (0) or `BS_NULL` (1). */
  style: number;
  color: number;
}

/** Fonts, pens and DCs as `GetObjectW` sees them: only the kind. */
export interface OtherObjectInfo {
  readonly kind: 'font' | 'pen' | 'dc';
}

export type GdiObjectInfo = BitmapInfo | BrushInfo | OtherObjectInfo;

export interface Gdi32Exports {
  /** Returns the bitmap and the address of its bits, or null. */
  CreateDIBSection(hdc: number, header: DibHeader): {bitmap: number; bits: number} | null;
  /** A device-dependent bitmap; `bits` (address or 0) initialises it. */
  CreateBitmap(
    width: number,
    height: number,
    planes: number,
    bitCount: number,
    bits: number,
  ): number;
  CreateCompatibleDC(hdc: number): number;
  DeleteDC(hdc: number): boolean;
  /** Returns the previously selected object of the type, `HGDI_ERROR` on failure. */
  SelectObject(hdc: number, object: number): number;
  DeleteObject(object: number): boolean;
  GetStockObject(index: number): number;
  /** `COLORREF` 0x00BBGGRR. */
  CreateSolidBrush(color: number): number;
  BitBlt(
    dst: number,
    x: number,
    y: number,
    width: number,
    height: number,
    src: number,
    sx: number,
    sy: number,
    rop: number,
  ): boolean;
  SetTextColor(hdc: number, color: number): number;
  SetBkColor(hdc: number, color: number): number;
  SetBkMode(hdc: number, mode: number): number;
  /**
   * `AddFontResourceExW(path, FR_PRIVATE, NULL)` with the file's bytes (the caller read them
   * through `kernel32.dll`): the number of fonts added, 0 when the file is not a font.
   */
  AddFontResourceExW(path: string, data: Uint8Array): number;
  RemoveFontResourceExW(path: string): boolean;
  /** `AddFontMemResourceEx`: the handle (0 on failure) and the number of fonts. */
  AddFontMemResourceEx(data: Uint8Array): {handle: number; count: number};
  RemoveFontMemResourceEx(handle: number): boolean;
  /** `GetObjectW`: what the object is, or null for an invalid handle. */
  GetObjectW(object: number): GdiObjectInfo | null;
}

export const GDI32 = defineNativeContract<Gdi32Exports>('gdi32.dll', '1');
