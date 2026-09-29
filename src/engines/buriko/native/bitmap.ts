import {cloneRasterText, releaseRasterText, withRasterText} from '../../../text/raster-text.js';
import {indexOfZeroByte} from '../../../core/binary.js';
import {allocateBurikoResidentBytes, releaseBurikoResidentBytes} from './bitmap-resident.js';

/** Frees resident bytes of storages that are collected without a native release. */
const residentFinalizer = new FinalizationRegistry<Uint8Array>(releaseBurikoResidentBytes);

/**
 * A kernel call whose result belongs in a storage but has not been computed in software, such
 * as a sprite mix the GPU draws directly. `settle` runs the software kernel on its unchanged
 * inputs, which reproduces the native result exactly, and detaches the write.
 */
export interface BurikoPendingWrite {
  settle(): void;
  /** Detach without computing, when nothing can observe the result any more. */
  discard(): void;
}

/** Native bitmap backing identity is shared by cropped descriptors and copied slot records. */
export class BurikoBitmapStorage {
  private readonly pixels: Uint8Array;
  private readonly pixelView: DataView;
  /**
   * Advances on every access that could write pixels: `bytes`, `view`, `written`, a write
   * range check and release. Cached copies, such as GPU textures, stay valid only while it is
   * unchanged, which holds however the pixels are later written. Reads through `bytes` or
   * `view` count too, so this is conservative.
   */
  generation = 0;
  // A contiguous initialized prefix needs no byte map. Allocate one only for holes.
  private defined: Uint8Array | null = null;
  private initializedPrefix = 0;
  private disposed = false;
  private nativeHeapReads = false;
  /** A deferred kernel whose result these pixels still lack. */
  private pendingWrite: BurikoPendingWrite | null = null;
  /** Deferred kernels that will read these pixels. */
  private pendingReaders: Set<BurikoPendingWrite> | null = null;
  constructor(bytes: Uint8Array, initialized: boolean) {
    this.pixels = bytes;
    this.pixelView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.initializedPrefix = initialized ? bytes.length : 0;
  }
  /**
   * New native storage, resident in the bitmap kernel's memory when possible so kernels work
   * on it in place. Its bytes start zero either way. Resident bytes must not be retained past
   * the storage: they return to the heap on release() or when the storage is collected.
   */
  get bytes(): Uint8Array {
    this.settleAll();
    this.generation++;
    return this.pixels;
  }
  get view(): DataView {
    this.settleAll();
    this.generation++;
    return this.pixelView;
  }
  get byteLength(): number {
    return this.pixels.length;
  }
  /** The backing array, for identity and overlap checks only. Its pixels may be stale. */
  backing(): Uint8Array {
    return this.pixels;
  }
  /**
   * Pixel bytes for a caller that only reads them and records `generation` first, such as a
   * GPU upload. Writing through this array would leave caches stale.
   */
  readOnlyBytes(): Uint8Array {
    this.pendingWrite?.settle();
    return this.pixels;
  }
  /** The deferred kernel whose result these pixels lack, if any. */
  get pending(): BurikoPendingWrite | null {
    return this.pendingWrite;
  }
  /**
   * Record `write` as this storage's content, reading `sources`. An earlier pending write is
   * dropped when `supersedes` says the new one replaces all of it, and settled otherwise.
   * `initialize` publishes the span the kernel will write, as its software run would.
   */
  defer(
    write: BurikoPendingWrite,
    sources: readonly BurikoBitmapStorage[],
    supersedes: (previous: BurikoPendingWrite) => boolean,
    initialize: readonly (readonly [number, number])[],
  ): void {
    const previous = this.pendingWrite;
    if (previous !== null) {
      if (supersedes(previous)) previous.discard();
      else previous.settle();
    }
    this.settleReaders();
    for (const [offset, length] of initialize) this.written(offset, length);
    this.pendingWrite = write;
    for (const source of sources) (source.pendingReaders ??= new Set()).add(write);
    this.generation++;
  }
  /** Detach a pending write from this storage and every storage it reads. */
  detach(write: BurikoPendingWrite, sources: readonly BurikoBitmapStorage[] = []): void {
    if (this.pendingWrite === write) this.pendingWrite = null;
    for (const source of sources) source.pendingReaders?.delete(write);
  }
  private settleReaders(): void {
    const readers = this.pendingReaders;
    if (readers === null || readers.size === 0) return;
    for (const reader of [...readers]) reader.settle();
  }
  private settleAll(): void {
    this.pendingWrite?.settle();
    this.settleReaders();
  }
  /** Whether a span is initialized, without counting as an access. */
  isInitialized(offset: number, length: number): boolean {
    return (
      !this.disposed &&
      Number.isSafeInteger(offset) &&
      Number.isSafeInteger(length) &&
      offset >= 0 &&
      length >= 0 &&
      offset + length <= this.pixels.length &&
      offset + length <= this.initializedPrefix
    );
  }
  static allocate(length: number, initialized: boolean): BurikoBitmapStorage {
    const resident = allocateBurikoResidentBytes(length);
    const storage = new BurikoBitmapStorage(resident ?? new Uint8Array(length), initialized);
    if (resident !== null) residentFinalizer.register(storage, resident, storage);
    return storage;
  }
  /** Initialized storage holding a copy of decoded pixels, resident when possible. */
  static adopt(bytes: Uint8Array): BurikoBitmapStorage {
    const resident = allocateBurikoResidentBytes(bytes.length);
    if (resident === null) return new BurikoBitmapStorage(bytes, true);
    resident.set(bytes);
    const storage = new BurikoBitmapStorage(resident, true);
    residentFinalizer.register(storage, resident, storage);
    return storage;
  }
  /** Import validity metadata without reading retained pixel storage. */
  static tracked(bytes: Uint8Array, initialized?: Uint8Array): BurikoBitmapStorage {
    const storage = new BurikoBitmapStorage(bytes, true);
    if (initialized !== undefined) {
      if (initialized.length !== bytes.length)
        throw new RangeError('Buriko bitmap validity does not cover its backing storage');
      storage.defined = initialized.slice();
      const firstUndefined = indexOfZeroByte(storage.defined);
      if (firstUndefined < 0) storage.defined = null;
      else storage.initializedPrefix = firstUndefined;
    }
    return storage;
  }
  private checkRange(offset: number, length: number): void {
    if (this.disposed) throw new Error('Buriko bitmap accesses a released native allocation');
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.pixels.length
    )
      throw new RangeError('Buriko bitmap accesses outside native allocation');
  }
  range(offset: number, length: number, read: boolean): void {
    this.checkRange(offset, length);
    if (read) this.pendingWrite?.settle();
    else {
      this.settleAll();
      this.generation++;
    }
    if (
      read &&
      !this.nativeHeapReads &&
      length !== 0 &&
      offset + length > this.initializedPrefix &&
      (this.defined === null ||
        indexOfZeroByte(this.defined.subarray(offset, offset + length)) >= 0)
    )
      throw new Error('Buriko bitmap reads unwritten native allocation');
  }
  written(offset: number, length: number): void {
    this.range(offset, length, false);
    if (length === 0) return;
    if (offset === 0 && length === this.pixels.length) {
      this.defined = null;
      this.initializedPrefix = this.pixels.length;
    } else if (this.defined === null) {
      if (offset <= this.initializedPrefix)
        this.initializedPrefix = Math.max(this.initializedPrefix, offset + length);
      else {
        this.defined = new Uint8Array(this.pixels.length);
        this.defined.fill(1, 0, this.initializedPrefix);
        this.defined.fill(1, offset, offset + length);
      }
    } else {
      this.defined.fill(1, offset, offset + length);
      // Sequential row/pair writes eventually initialize the entire allocation.
      // Visit each newly initialized byte once, then retire its validity map.
      if (offset <= this.initializedPrefix && offset + length > this.initializedPrefix) {
        this.initializedPrefix = offset + length;
        while (this.defined[this.initializedPrefix] === 1) this.initializedPrefix++;
        if (this.initializedPrefix === this.pixels.length) this.defined = null;
      }
    }
  }
  /** Synchronous pixel kernels may bypass per-pixel checks only on initialized, bounded spans. */
  initializedView(offset: number, length: number): DataView | null {
    if (
      this.disposed ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.pixels.length ||
      offset + length > this.initializedPrefix
    )
      return null;
    return this.view;
  }
  /** Native callers may sample untouched _aligned_malloc bytes without a fault. */
  allowNativeHeapReads(): void {
    this.nativeHeapReads = true;
  }
  /** Copy native initialization state without reading the stored pixel values. */
  initializedRange(offset: number, length: number): Uint8Array {
    this.checkRange(offset, length);
    return this.defined === null
      ? new Uint8Array(length).fill(
          1,
          0,
          Math.max(0, Math.min(length, this.initializedPrefix - offset)),
        )
      : this.defined.slice(offset, offset + length);
  }
  /**
   * Native temporary pixel snapshots preserve unwritten bytes and their state. Large clones,
   * such as raster-text presentation planes that replay every draw, are resident too.
   */
  cloneRange(offset: number, length: number): BurikoBitmapStorage {
    this.range(offset, length, false);
    this.pendingWrite?.settle();
    const source = this.pixels.subarray(offset, offset + length),
      resident = allocateBurikoResidentBytes(length);
    resident?.set(source);
    const clone = new BurikoBitmapStorage(resident ?? source.slice(), true);
    if (resident !== null) residentFinalizer.register(clone, resident, clone);
    if (this.defined !== null) {
      clone.defined = this.defined.slice(offset, offset + length);
    }
    clone.initializedPrefix = Math.max(0, Math.min(length, this.initializedPrefix - offset));
    clone.nativeHeapReads = this.nativeHeapReads;
    cloneRasterText(this, clone, offset, length);
    return clone;
  }
  release(): void {
    // Readers still need these pixels; this storage's own pending result is never needed.
    this.settleReaders();
    this.pendingWrite?.discard();
    this.pendingWrite = null;
    releaseRasterText(this);
    if (!this.disposed && residentFinalizer.unregister(this))
      releaseBurikoResidentBytes(this.pixels);
    this.generation++;
    this.disposed = true;
  }
}

/** 32-byte native descriptor at bitmap slot +8: pointer,+8 stride,+c width,+10 height,+14 format,+18 bpp. */
export interface BurikoBitmap {
  storage: BurikoBitmapStorage | null;
  offset: number;
  stride: number;
  width: number;
  height: number;
  format: number;
  bytesPerPixel: number;
}

export interface BurikoBitmapRectangle {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function burikoBitmapPixelSize(format: number): number {
  const size = [2, 4, 4, 1, 4, 4, 6, 4][format >>> 0];
  if (size === undefined)
    throw new RangeError('Buriko bitmap format indexes outside native pixel-size table');
  return size;
}

/** 140041f80 allocates only when both dimensions are nonzero; it does not clear allocation bytes. */
export function allocateBurikoBitmap(width: number, height: number, format: number): BurikoBitmap {
  width |= 0;
  height |= 0;
  format >>>= 0;
  const bytesPerPixel = burikoBitmapPixelSize(format);
  const stride = Math.imul(bytesPerPixel, width);
  const storage =
    width !== 0 && height !== 0
      ? BurikoBitmapStorage.allocate(Math.imul(stride, height) >>> 0, false)
      : null;
  return {storage, offset: 0, stride, width, height, format, bytesPerPixel};
}

export function burikoBitmapRectangle(bitmap: BurikoBitmap): BurikoBitmapRectangle {
  return {left: 0, top: 0, right: (bitmap.width - 1) | 0, bottom: (bitmap.height - 1) | 0};
}

export function translateBurikoBitmapRectangle(
  rectangle: BurikoBitmapRectangle,
  x: number,
  y: number,
): void {
  rectangle.left = (rectangle.left + x) | 0;
  rectangle.right = (rectangle.right + x) | 0;
  rectangle.top = (rectangle.top + y) | 0;
  rectangle.bottom = (rectangle.bottom + y) | 0;
}

/** 140041f20 mutates all four edges even when the resulting intersection is empty. */
export function intersectBurikoBitmapRectangle(
  destination: BurikoBitmapRectangle,
  source: BurikoBitmapRectangle,
): boolean {
  destination.left = Math.max(destination.left, source.left);
  destination.top = Math.max(destination.top, source.top);
  destination.right = Math.min(destination.right, source.right);
  destination.bottom = Math.min(destination.bottom, source.bottom);
  return destination.left <= destination.right && destination.top <= destination.bottom;
}

/** 140041e60 changes only pointer/width/height after successful inclusive clipping. */
export function cropBurikoBitmap(bitmap: BurikoBitmap, rectangle: BurikoBitmapRectangle): boolean {
  const clipped = burikoBitmapRectangle(bitmap);
  if (!intersectBurikoBitmapRectangle(clipped, rectangle)) return false;
  bitmap.width = (clipped.right - clipped.left + 1) | 0;
  bitmap.height = (clipped.bottom - clipped.top + 1) | 0;
  bitmap.offset +=
    (Math.imul(bitmap.bytesPerPixel, clipped.left) + Math.imul(bitmap.stride, clipped.top)) >>> 0;
  return true;
}

/** 1400414b0's two descriptors after native inclusive rectangle clipping. */
export function clipBurikoBitmapPair(
  destination: BurikoBitmap,
  x: number,
  y: number,
  source: BurikoBitmap,
): {destination: BurikoBitmap; source: BurikoBitmap} | null {
  const target = {...destination};
  const input = {...source};
  const destinationRect = burikoBitmapRectangle(target);
  const sourceRect = burikoBitmapRectangle(input);
  translateBurikoBitmapRectangle(destinationRect, -x, -y);
  if (!intersectBurikoBitmapRectangle(sourceRect, destinationRect)) return null;
  cropBurikoBitmap(input, sourceRect);
  translateBurikoBitmapRectangle(sourceRect, x, y);
  cropBurikoBitmap(target, sourceRect);
  return {destination: target, source: input};
}

/** 14003e1f0 compatibility is deliberately asymmetric for format three. */
export function burikoBitmapFormatsCompatible(destination: number, source: number): boolean {
  if (destination === source) return true;
  if (destination === 1) return (source - 2) >>> 0 < 2;
  if (destination === 2) return (((source - 1) >>> 0) & 0xfffffffd) === 0;
  return destination === 3 && source === 2;
}

export function bitmapStorage(
  bitmap: BurikoBitmap,
  offset: number,
  length: number,
  read: boolean,
): BurikoBitmapStorage {
  const storage = bitmap.storage;
  if (storage === null) throw new TypeError('Buriko bitmap dereferences a null native pointer');
  storage.range(offset, length, read);
  return storage;
}

/** A checked envelope for fixed four-byte pixel traversal; unusual descriptors use scalar checks. */
export function initializedBurikoBitmapView(
  bitmap: BurikoBitmap,
  width: number,
  height: number,
): DataView | null {
  if (width === 0 || height === 0 || !Number.isSafeInteger(bitmap.stride)) return null;
  const lastRow = bitmap.offset + (height - 1) * bitmap.stride;
  const first = Math.min(bitmap.offset, lastRow);
  const end = Math.max(bitmap.offset, lastRow) + width * 4;
  return bitmap.storage?.initializedView(first, end - first) ?? null;
}

/** initializedBurikoBitmapView's check alone: it neither reads pixels nor settles them. */
export function burikoBitmapInitialized(
  bitmap: BurikoBitmap,
  width: number,
  height: number,
): boolean {
  if (width === 0 || height === 0 || !Number.isSafeInteger(bitmap.stride)) return false;
  const lastRow = bitmap.offset + (height - 1) * bitmap.stride;
  const first = Math.min(bitmap.offset, lastRow);
  const end = Math.max(bitmap.offset, lastRow) + width * 4;
  return bitmap.storage?.isInitialized(first, end - first) ?? false;
}

/** Checked write-only envelope; callers mark only completed rows as written. */
export function writableBurikoBitmapView(
  bitmap: BurikoBitmap,
  width: number,
  height: number,
): DataView | null {
  if (
    !Number.isSafeInteger(width) ||
    width <= 0 ||
    !Number.isSafeInteger(height) ||
    height <= 0 ||
    !Number.isSafeInteger(bitmap.stride)
  )
    return null;
  const lastRow = bitmap.offset + (height - 1) * bitmap.stride,
    first = Math.min(bitmap.offset, lastRow),
    end = Math.max(bitmap.offset, lastRow) + width * 4,
    storage = bitmap.storage;
  if (
    storage === null ||
    !Number.isSafeInteger(first) ||
    first < 0 ||
    !Number.isSafeInteger(end) ||
    end > storage.bytes.length
  )
    return null;
  // The empty initialized envelope checks lifetime without requiring initialized output.
  return storage.initializedView(0, 0);
}

/** 14003e530 converts RGB888 to native 5:5:5 then fills exactly width pixels per row. */
function fillBurikoBitmap16Pixels(bitmap: BurikoBitmap, color: number): void {
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
function fillBurikoBitmap32Pixels(bitmap: BurikoBitmap, color: number): void {
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
function fillBurikoBitmapPixels(bitmap: BurikoBitmap, color: number): void {
  if (bitmap.format === 0) fillBurikoBitmap16(bitmap, color);
  else if (bitmap.format === 1 || bitmap.format === 2)
    fillBurikoBitmap32(bitmap, bitmap.format === 1 ? color & 0xffffff : color);
  else if (bitmap.format === 3)
    for (let y = 0; y < bitmap.height >>> 0; y++) {
      const offset = bitmap.offset + y * bitmap.stride;
      const storage = bitmapStorage(bitmap, offset, bitmap.width >>> 0, false);
      storage.bytes.fill(color & 255, offset, offset + (bitmap.width >>> 0));
      storage.written(offset, bitmap.width >>> 0);
    }
}

export const fillBurikoBitmap16 = withRasterText(fillBurikoBitmap16Pixels, {clear: true});
export const fillBurikoBitmap32 = withRasterText(fillBurikoBitmap32Pixels, {clear: true});
export const fillBurikoBitmap = withRasterText(fillBurikoBitmapPixels, {
  clear: true,
  applied: (_, [bitmap]) => bitmap.format < 4,
});
