/**
 * `gdi32.dll` with bitmaps in the process memory: DIB sections and device bitmaps, memory
 * device contexts, `SRCCOPY` blits between 24- and 32-bit bitmaps, solid brushes, stock
 * objects and the text colour state of a DC. Text output and other raster operations are not
 * available.
 */
import type {NativeLibraryImplementation} from '../../platform/native-libraries.js';
import type {NativeAddressSpace} from '../../platform/native-process.js';
import {
  BI_BITFIELDS,
  BI_RGB,
  CLR_INVALID,
  GDI32,
  HGDI_ERROR,
  OPAQUE,
  SRCCOPY,
  type DibHeader,
  type Gdi32Exports,
  type GdiObjectInfo,
} from './contract.js';

interface BitmapObject {
  readonly kind: 'bitmap';
  readonly width: number;
  readonly height: number;
  readonly bitCount: number;
  readonly stride: number;
  readonly topDown: boolean;
  readonly bits: number;
  readonly size: number;
  dc: DcObject | null;
}

interface BrushObject {
  readonly kind: 'brush';
  readonly style: number;
  readonly color: number;
}

interface OtherObject {
  readonly kind: 'font' | 'pen';
}

interface DcObject {
  readonly kind: 'dc';
  bitmap: BitmapObject;
  brush: number;
  pen: number;
  font: number;
  textColor: number;
  bkColor: number;
  bkMode: number;
}

type GdiObject = BitmapObject | BrushObject | OtherObject | DcObject;

const STOCK_BASE = 0x01900010;

/** The number of fonts in a TrueType/OpenType file or collection; 0 for other data. */
function fontCount(data: Uint8Array): number {
  if (data.length < 12) return 0;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const tag = dv.getUint32(0);
  if (tag === 0x74746366) return dv.getUint32(8); // 'ttcf'
  if (tag === 0x00010000 || tag === 0x4f54544f || tag === 0x74727565) return 1; // 1.0, 'OTTO', 'true'
  return 0;
}
const STOCK_COUNT = 20;

class Gdi32 implements Gdi32Exports {
  readonly #objects = new Map<number, GdiObject>();
  #next = 0x05000010;
  readonly #stockBitmap: number;

  constructor(private readonly memory: NativeAddressSpace) {
    const brushes: [number, number][] = [
      [0, 0xffffff],
      [1, 0xc0c0c0],
      [2, 0x808080],
      [3, 0x404040],
      [4, 0x000000],
    ];
    for (const [i, color] of brushes)
      this.#objects.set(STOCK_BASE + i, {kind: 'brush', style: 0, color});
    this.#objects.set(STOCK_BASE + 5, {kind: 'brush', style: 1, color: 0});
    for (const i of [6, 7, 8]) this.#objects.set(STOCK_BASE + i, {kind: 'pen'});
    for (const i of [10, 11, 12, 13, 14, 16, 17]) this.#objects.set(STOCK_BASE + i, {kind: 'font'});
    // The 1×1 monochrome bitmap a new memory DC selects.
    this.#stockBitmap = STOCK_BASE + 19;
    this.#objects.set(this.#stockBitmap, this.#newBitmap(1, 1, 1, false));
  }

  #handle(object: GdiObject): number {
    const h = this.#next;
    this.#next += 4;
    this.#objects.set(h, object);
    return h;
  }

  #isStock(h: number): boolean {
    return h >= STOCK_BASE && h < STOCK_BASE + STOCK_COUNT;
  }

  #newBitmap(
    width: number,
    height: number,
    bitCount: number,
    dib: boolean,
    topDown = false,
  ): BitmapObject {
    const stride = dib
      ? ((width * bitCount + 31) >>> 5) << 2
      : ((width * bitCount + 15) >>> 4) << 1;
    const size = Math.max(1, stride * height);
    const bits = this.memory.allocate(size, dib ? 'CreateDIBSection' : 'CreateBitmap');
    return {kind: 'bitmap', width, height, bitCount, stride, topDown, bits, size, dc: null};
  }

  CreateDIBSection: Gdi32Exports['CreateDIBSection'] = (_hdc, header: DibHeader) => {
    const bc = header.bitCount;
    if (header.width <= 0 || header.height === 0 || ![1, 4, 8, 16, 24, 32].includes(bc))
      return null;
    if (header.compression !== BI_RGB && header.compression !== BI_BITFIELDS) return null;
    const bmp = this.#newBitmap(header.width, Math.abs(header.height), bc, true, header.height < 0);
    return {bitmap: this.#handle(bmp), bits: bmp.bits};
  };

  CreateBitmap: Gdi32Exports['CreateBitmap'] = (width, height, planes, bitCount, bits) => {
    if (width <= 0 || height <= 0 || planes !== 1) return 0;
    const bmp = this.#newBitmap(width, height, bitCount, false, true);
    if (bits) this.memory.u8.copyWithin(bmp.bits, bits, bits + bmp.stride * height);
    return this.#handle(bmp);
  };

  CreateCompatibleDC: Gdi32Exports['CreateCompatibleDC'] = () =>
    this.#handle({
      kind: 'dc',
      bitmap: this.#objects.get(this.#stockBitmap) as BitmapObject,
      brush: STOCK_BASE,
      pen: STOCK_BASE + 7,
      font: STOCK_BASE + 13,
      textColor: 0,
      bkColor: 0xffffff,
      bkMode: OPAQUE,
    });

  #dc(h: number): DcObject | null {
    const o = this.#objects.get(h >>> 0);
    return o?.kind === 'dc' ? o : null;
  }

  DeleteDC: Gdi32Exports['DeleteDC'] = (hdc) => {
    const dc = this.#dc(hdc);
    if (!dc) return false;
    dc.bitmap.dc = null;
    this.#objects.delete(hdc >>> 0);
    return true;
  };

  SelectObject: Gdi32Exports['SelectObject'] = (hdc, h) => {
    const dc = this.#dc(hdc);
    const o = this.#objects.get(h >>> 0);
    if (!dc || !o) return HGDI_ERROR | 0;
    switch (o.kind) {
      case 'bitmap': {
        if (o.dc && o.dc !== dc) return 0;
        const prev = [...this.#objects].find(([, v]) => v === dc.bitmap)?.[0] ?? 0;
        dc.bitmap.dc = null;
        dc.bitmap = o;
        o.dc = dc;
        return prev;
      }
      case 'brush': {
        const prev = dc.brush;
        dc.brush = h >>> 0;
        return prev;
      }
      case 'pen': {
        const prev = dc.pen;
        dc.pen = h >>> 0;
        return prev;
      }
      case 'font': {
        const prev = dc.font;
        dc.font = h >>> 0;
        return prev;
      }
      default:
        return HGDI_ERROR | 0;
    }
  };

  DeleteObject: Gdi32Exports['DeleteObject'] = (h) => {
    const o = this.#objects.get(h >>> 0);
    if (!o || o.kind === 'dc') return false;
    if (this.#isStock(h >>> 0)) return true;
    // A bitmap selected into a DC cannot be deleted.
    if (o.kind === 'bitmap') {
      if (o.dc) return false;
      this.memory.free(o.bits, o.size);
    }
    this.#objects.delete(h >>> 0);
    return true;
  };

  GetStockObject: Gdi32Exports['GetStockObject'] = (index) =>
    this.#objects.has(STOCK_BASE + index) && index !== 19 ? STOCK_BASE + index : 0;

  CreateSolidBrush: Gdi32Exports['CreateSolidBrush'] = (color) =>
    this.#handle({kind: 'brush', style: 0, color: color & 0xffffff});

  BitBlt: Gdi32Exports['BitBlt'] = (dst, x, y, width, height, src, sx, sy, rop) => {
    const d = this.#dc(dst);
    const s = this.#dc(src);
    if (!d || !s || rop >>> 0 !== SRCCOPY) return false;
    const db = d.bitmap;
    const sb = s.bitmap;
    if (![24, 32].includes(db.bitCount) || ![24, 32].includes(sb.bitCount)) return false;
    const u8 = this.memory.u8;
    const dbpp = db.bitCount >> 3;
    const sbpp = sb.bitCount >> 3;
    for (let j = 0; j < height; j++) {
      const ty = y + j;
      const fy = sy + j;
      if (ty < 0 || ty >= db.height || fy < 0 || fy >= sb.height) continue;
      const drow = db.bits + (db.topDown ? ty : db.height - 1 - ty) * db.stride;
      const srow = sb.bits + (sb.topDown ? fy : sb.height - 1 - fy) * sb.stride;
      for (let i = 0; i < width; i++) {
        const tx = x + i;
        const fx = sx + i;
        if (tx < 0 || tx >= db.width || fx < 0 || fx >= sb.width) continue;
        const dp = drow + tx * dbpp;
        const sp = srow + fx * sbpp;
        u8[dp] = u8[sp]!;
        u8[dp + 1] = u8[sp + 1]!;
        u8[dp + 2] = u8[sp + 2]!;
        if (dbpp === 4) u8[dp + 3] = sbpp === 4 ? u8[sp + 3]! : 0;
      }
    }
    return true;
  };

  SetTextColor: Gdi32Exports['SetTextColor'] = (hdc, color) => {
    const dc = this.#dc(hdc);
    if (!dc) return CLR_INVALID | 0;
    const prev = dc.textColor;
    dc.textColor = color & 0xffffff;
    return prev;
  };

  SetBkColor: Gdi32Exports['SetBkColor'] = (hdc, color) => {
    const dc = this.#dc(hdc);
    if (!dc) return CLR_INVALID | 0;
    const prev = dc.bkColor;
    dc.bkColor = color & 0xffffff;
    return prev;
  };

  SetBkMode: Gdi32Exports['SetBkMode'] = (hdc, mode) => {
    const dc = this.#dc(hdc);
    if (!dc) return 0;
    const prev = dc.bkMode;
    dc.bkMode = mode;
    return prev;
  };

  /** Private fonts by file name and by memory handle, with their font counts. */
  readonly #fileFonts = new Map<string, {data: Uint8Array; count: number}>();
  readonly #memoryFonts = new Map<number, {data: Uint8Array; count: number}>();
  #nextFontHandle = 0x0f000010;

  AddFontResourceExW: Gdi32Exports['AddFontResourceExW'] = (path, data) => {
    const count = fontCount(data);
    if (count > 0) this.#fileFonts.set(path.toLowerCase(), {data, count});
    return count;
  };
  RemoveFontResourceExW: Gdi32Exports['RemoveFontResourceExW'] = (path) =>
    this.#fileFonts.delete(path.toLowerCase());
  AddFontMemResourceEx: Gdi32Exports['AddFontMemResourceEx'] = (data) => {
    const count = fontCount(data);
    if (!count) return {handle: 0, count: 0};
    const handle = this.#nextFontHandle;
    this.#nextFontHandle += 4;
    this.#memoryFonts.set(handle, {data, count});
    return {handle, count};
  };
  RemoveFontMemResourceEx: Gdi32Exports['RemoveFontMemResourceEx'] = (handle) =>
    this.#memoryFonts.delete(handle);

  GetObjectW: Gdi32Exports['GetObjectW'] = (h): GdiObjectInfo | null => {
    const o = this.#objects.get(h >>> 0);
    if (!o) return null;
    switch (o.kind) {
      case 'bitmap':
        return {
          kind: 'bitmap',
          width: o.width,
          height: o.height,
          bitCount: o.bitCount,
          widthBytes: o.stride,
          bits: o.bits,
        };
      case 'brush':
        return {kind: 'brush', style: o.style, color: o.color};
      default:
        return {kind: o.kind};
    }
  };
}

/** `gdi32.dll` for a process. */
export function gdi32Library(): NativeLibraryImplementation<Gdi32Exports> {
  return {
    contract: GDI32,
    identities: [{kind: 'system', fileName: 'gdi32.dll'}],
    imports: [],
    link: (context) => ({exports: new Gdi32(context.process.memory)}),
  };
}
