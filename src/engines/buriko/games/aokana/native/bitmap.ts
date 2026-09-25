/** Native bitmap backing identity is shared by cropped descriptors and copied slot records. */
export class AokanaBitmapStorage {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  private defined: Uint8Array | null;
  private disposed = false;
  private nativeHeapReads = false;
  constructor(bytes: Uint8Array, initialized: boolean) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.defined = initialized ? null : new Uint8Array(bytes.length);
  }
  /** Import validity metadata without reading retained pixel storage. */
  static tracked(bytes: Uint8Array, initialized?: Uint8Array): AokanaBitmapStorage {
    const storage = new AokanaBitmapStorage(bytes, initialized === undefined);
    if (initialized !== undefined) {
      if (initialized.length !== bytes.length)
        throw new RangeError('Aokana bitmap validity does not cover its backing storage');
      storage.defined = initialized.slice();
    }
    return storage;
  }
  range(offset: number, length: number, read: boolean): void {
    if (this.disposed) throw new Error('Aokana bitmap accesses a released native allocation');
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.bytes.length
    )
      throw new RangeError('Aokana bitmap accesses outside native allocation');
    if (read && this.defined !== null && !this.nativeHeapReads)
      for (let index = offset; index < offset + length; index++)
        if (this.defined[index] === 0)
          throw new Error('Aokana bitmap reads unwritten native allocation');
  }
  written(offset: number, length: number): void {
    this.range(offset, length, false);
    if (offset === 0 && length === this.bytes.length) this.defined = null;
    else this.defined?.fill(1, offset, offset + length);
  }
  /** Native callers may sample untouched _aligned_malloc bytes without a fault. */
  allowNativeHeapReads(): void {
    this.nativeHeapReads = true;
  }
  /** Copy native initialization state without reading the stored pixel values. */
  initializedRange(offset: number, length: number): Uint8Array {
    this.range(offset, length, false);
    return this.defined === null
      ? new Uint8Array(length).fill(1)
      : this.defined.slice(offset, offset + length);
  }
  /** Native temporary pixel snapshots preserve unwritten bytes and their state. */
  cloneRange(offset: number, length: number): AokanaBitmapStorage {
    this.range(offset, length, false);
    const clone = new AokanaBitmapStorage(
      this.bytes.slice(offset, offset + length),
      this.defined === null,
    );
    if (this.defined !== null) clone.defined = this.defined.slice(offset, offset + length);
    clone.nativeHeapReads = this.nativeHeapReads;
    return clone;
  }
  release(): void {
    this.disposed = true;
  }
}

/** 32-byte native descriptor at bitmap slot +8: pointer,+8 stride,+c width,+10 height,+14 format,+18 bpp. */
export interface AokanaBitmap {
  storage: AokanaBitmapStorage | null;
  offset: number;
  stride: number;
  width: number;
  height: number;
  format: number;
  bytesPerPixel: number;
}

export interface AokanaBitmapRectangle {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function aokanaBitmapPixelSize(format: number): number {
  const size = [2, 4, 4, 1, 4, 4, 6, 4][format >>> 0];
  if (size === undefined)
    throw new RangeError('Aokana bitmap format indexes outside native pixel-size table');
  return size;
}

/** 140041f80 allocates only when both dimensions are nonzero; it does not clear allocation bytes. */
export function allocateAokanaBitmap(width: number, height: number, format: number): AokanaBitmap {
  width |= 0;
  height |= 0;
  format >>>= 0;
  const bytesPerPixel = aokanaBitmapPixelSize(format);
  const stride = Math.imul(bytesPerPixel, width);
  const storage =
    width !== 0 && height !== 0
      ? new AokanaBitmapStorage(new Uint8Array(Math.imul(stride, height) >>> 0), false)
      : null;
  return {storage, offset: 0, stride, width, height, format, bytesPerPixel};
}

export function aokanaBitmapRectangle(bitmap: AokanaBitmap): AokanaBitmapRectangle {
  return {left: 0, top: 0, right: (bitmap.width - 1) | 0, bottom: (bitmap.height - 1) | 0};
}

export function translateAokanaBitmapRectangle(
  rectangle: AokanaBitmapRectangle,
  x: number,
  y: number,
): void {
  rectangle.left = (rectangle.left + x) | 0;
  rectangle.right = (rectangle.right + x) | 0;
  rectangle.top = (rectangle.top + y) | 0;
  rectangle.bottom = (rectangle.bottom + y) | 0;
}

/** 140041f20 mutates all four edges even when the resulting intersection is empty. */
export function intersectAokanaBitmapRectangle(
  destination: AokanaBitmapRectangle,
  source: AokanaBitmapRectangle,
): boolean {
  destination.left = Math.max(destination.left, source.left);
  destination.top = Math.max(destination.top, source.top);
  destination.right = Math.min(destination.right, source.right);
  destination.bottom = Math.min(destination.bottom, source.bottom);
  return destination.left <= destination.right && destination.top <= destination.bottom;
}

/** 140041e60 changes only pointer/width/height after successful inclusive clipping. */
export function cropAokanaBitmap(bitmap: AokanaBitmap, rectangle: AokanaBitmapRectangle): boolean {
  const clipped = aokanaBitmapRectangle(bitmap);
  if (!intersectAokanaBitmapRectangle(clipped, rectangle)) return false;
  bitmap.width = (clipped.right - clipped.left + 1) | 0;
  bitmap.height = (clipped.bottom - clipped.top + 1) | 0;
  bitmap.offset +=
    (Math.imul(bitmap.bytesPerPixel, clipped.left) + Math.imul(bitmap.stride, clipped.top)) >>> 0;
  return true;
}

/** 1400414b0's two descriptors after native inclusive rectangle clipping. */
export function clipAokanaBitmapPair(
  destination: AokanaBitmap,
  x: number,
  y: number,
  source: AokanaBitmap,
): {destination: AokanaBitmap; source: AokanaBitmap} | null {
  const target = {...destination};
  const input = {...source};
  const destinationRect = aokanaBitmapRectangle(target);
  const sourceRect = aokanaBitmapRectangle(input);
  translateAokanaBitmapRectangle(destinationRect, -x, -y);
  if (!intersectAokanaBitmapRectangle(sourceRect, destinationRect)) return null;
  cropAokanaBitmap(input, sourceRect);
  translateAokanaBitmapRectangle(sourceRect, x, y);
  cropAokanaBitmap(target, sourceRect);
  return {destination: target, source: input};
}

/** 14003e1f0 compatibility is deliberately asymmetric for format three. */
export function aokanaBitmapFormatsCompatible(destination: number, source: number): boolean {
  if (destination === source) return true;
  if (destination === 1) return (source - 2) >>> 0 < 2;
  if (destination === 2) return (((source - 1) >>> 0) & 0xfffffffd) === 0;
  return destination === 3 && source === 2;
}

export function bitmapStorage(
  bitmap: AokanaBitmap,
  offset: number,
  length: number,
  read: boolean,
): AokanaBitmapStorage {
  const storage = bitmap.storage;
  if (storage === null) throw new TypeError('Aokana bitmap dereferences a null native pointer');
  storage.range(offset, length, read);
  return storage;
}

/** 14003e530 converts RGB888 to native 5:5:5 then fills exactly width pixels per row. */
export function fillAokanaBitmap16(bitmap: AokanaBitmap, color: number): void {
  const pixel = ((color >>> 9) & 0x7c00) + ((color >>> 6) & 0x3e0) + ((color >>> 3) & 0x1f);
  for (let y = 0; y < bitmap.height >>> 0; y++) {
    const start = bitmap.offset + y * bitmap.stride;
    for (let x = 0; x < bitmap.width >>> 0; x++) {
      const offset = start + x * 2;
      const storage = bitmapStorage(bitmap, offset, 2, false);
      storage.view.setUint16(offset, pixel, true);
      storage.written(offset, 2);
    }
  }
}

/** 14003e400's scalar/SIMD fill branches have identical stores and row padding remains untouched. */
export function fillAokanaBitmap32(bitmap: AokanaBitmap, color: number): void {
  for (let y = 0; y < bitmap.height >>> 0; y++) {
    const start = bitmap.offset + y * bitmap.stride;
    for (let x = 0; x < bitmap.width >>> 0; x++) {
      const offset = start + x * 4;
      const storage = bitmapStorage(bitmap, offset, 4, false);
      storage.view.setUint32(offset, color, true);
      storage.written(offset, 4);
    }
  }
}

/** 14003e5a0's full-format fill dispatcher; formats four and above perform no write. */
export function fillAokanaBitmap(bitmap: AokanaBitmap, color: number): void {
  if (bitmap.format === 0) fillAokanaBitmap16(bitmap, color);
  else if (bitmap.format === 1 || bitmap.format === 2)
    fillAokanaBitmap32(bitmap, bitmap.format === 1 ? color & 0xffffff : color);
  else if (bitmap.format === 3)
    for (let y = 0; y < bitmap.height >>> 0; y++) {
      const offset = bitmap.offset + y * bitmap.stride;
      const storage = bitmapStorage(bitmap, offset, bitmap.width >>> 0, false);
      storage.bytes.fill(color & 255, offset, offset + (bitmap.width >>> 0));
      storage.written(offset, bitmap.width >>> 0);
    }
}
