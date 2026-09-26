import {BurikoBitmapStorage, type BurikoBitmapRectangle} from './bitmap.js';
import {burikoStartupCpuLog} from './startup-budget.js';
import {
  copyRasterTextPresentation,
  clearRasterTextPresentation,
  type RasterTextBitmap,
} from '../../../text/raster-text.js';

export type BurikoDisplayTextureFormat = 21 | 22; // A8R8G8B8 / X8R8G8B8.
export interface BurikoLockedDisplayTexture {
  storage: BurikoBitmapStorage;
  offset: number;
  pitch: number;
}

/** b2d20 uses the native logarithm to ceil each positive DWORD dimension to a power of two. */
export function burikoDisplayTextureSize(width: number, height: number): readonly [number, number] {
  const divisor = burikoStartupCpuLog(2);
  const dimension = (value: number): number => {
    const ratio = burikoStartupCpuLog(value) / divisor;
    const integer = Math.trunc(ratio);
    const exponent = integer + (ratio - integer > 0 ? 1 : 0);
    return Number(BigInt.asUintN(32, BigInt(2 ** exponent)));
  };
  return [dimension(width), dimension(height)];
}

/**
 * One concrete level-zero display texture in the browser's software device profile.
 * Its BGRA rows have a four-byte pixel size independently of the engine descriptor's
 * selected bitmap format. Browser buffers start zeroed; native D3D padding is device
 * dependent. Only the logical rectangle is initialized by the native GDI clear path.
 */
export class BurikoDisplayTexture {
  readonly storage: BurikoBitmapStorage;
  readonly pitch: number;
  private readonly words: Uint32Array;
  private locked = false;
  private disposed = false;
  private presentationView: BurikoDisplayTexture | null = null;
  private dirty: BurikoBitmapRectangle[] = [];
  /** Conservative union of texels changed by the last successful update. */
  updateBounds: BurikoBitmapRectangle | null = null;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly format: BurikoDisplayTextureFormat,
  ) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
      throw new RangeError('Buriko display texture dimensions must be positive integers');
    this.pitch = width * 4;
    this.storage = new BurikoBitmapStorage(new Uint8Array(this.pitch * height), true);
    this.words = new Uint32Array(this.storage.bytes.buffer);
    this.addDirtyRectangle({left: 0, top: 0, right: width - 1, bottom: height - 1});
  }
  private check(): void {
    if (this.disposed) throw new Error('Buriko display texture is no longer available');
  }
  get textBitmap(): RasterTextBitmap {
    return {
      storage: this.storage,
      offset: 0,
      stride: this.pitch,
      width: this.width,
      height: this.height,
      bytesPerPixel: 4,
    };
  }
  /** Read-only sampling view; freeze backing only if native retirement precedes a mode switch. */
  forPresentation(): BurikoDisplayTexture {
    this.check();
    return (this.presentationView ??= Object.create(this) as BurikoDisplayTexture);
  }
  discardPresentation(): void {
    this.presentationView = null;
  }
  /** LockRect(0,NULL,D3DLOCK_NO_DIRTY_UPDATE); no automatic dirty-region insertion. */
  lock(): BurikoLockedDisplayTexture | null {
    this.check();
    if (this.locked) return null;
    this.locked = true;
    return {storage: this.storage, offset: 0, pitch: this.pitch};
  }
  unlock(): boolean {
    this.check();
    if (!this.locked) return false;
    this.locked = false;
    return true;
  }
  /** b23a0's GetDC/FillRect black initialization covers only the logical image. */
  clearLogical(width: number, height: number): void {
    this.check();
    if (width < 0 || height < 0 || width > this.width || height > this.height)
      throw new RangeError('Buriko logical image exceeds its display texture');
    for (let y = 0; y < height; y++)
      this.storage.bytes.fill(0, y * this.pitch, y * this.pitch + width * 4);
    clearRasterTextPresentation({...this.textBitmap, width, height});
    this.addDirtyRectangle({left: 0, top: 0, right: width - 1, bottom: height - 1});
  }
  /** AddDirtyRect's exclusive right/bottom are converted at the native caller boundary. */
  addDirtyRectangle(rectangle: BurikoBitmapRectangle): void {
    this.check();
    const clipped = {
      left: Math.max(0, rectangle.left | 0),
      top: Math.max(0, rectangle.top | 0),
      right: Math.min(this.width - 1, rectangle.right | 0),
      bottom: Math.min(this.height - 1, rectangle.bottom | 0),
    };
    if (clipped.left <= clipped.right && clipped.top <= clipped.bottom) this.dirty.push(clipped);
  }
  /** UpdateTexture copies changed dirty rows, clears source dirtiness and reports pixel changes. */
  updateFrom(source: BurikoDisplayTexture): boolean {
    this.check();
    source.check();
    if (
      this.width !== source.width ||
      this.height !== source.height ||
      this.format !== source.format
    )
      throw new Error('Buriko display textures have incompatible update descriptors');
    let bounds: BurikoBitmapRectangle | null = null;
    for (const rectangle of source.dirty)
      for (let y = rectangle.top; y <= rectangle.bottom; y++) {
        const offset = y * this.pitch + rectangle.left * 4;
        const length = (rectangle.right - rectangle.left + 1) * 4;
        source.storage.range(offset, length, true);
        const first = offset >>> 2;
        const last = (offset + length) >>> 2;
        let begin = first;
        while (begin < last && this.words[begin] === source.words[begin]) begin++;
        if (begin < last) {
          let end = last;
          while (end > begin + 1 && this.words[end - 1] === source.words[end - 1]) end--;
          this.storage.bytes.set(source.storage.bytes.subarray(begin * 4, end * 4), begin * 4);
          const left = begin - y * this.width,
            right = end - y * this.width - 1;
          if (bounds === null) bounds = {left, top: y, right, bottom: y};
          else {
            bounds.left = Math.min(bounds.left, left);
            bounds.top = Math.min(bounds.top, y);
            bounds.right = Math.max(bounds.right, right);
            bounds.bottom = Math.max(bounds.bottom, y);
          }
        }
      }
    // Equal pixels may carry a different string, but untouched dirty regions stay unuploaded.
    for (const rectangle of source.dirty) {
      const crop = {
        offset: rectangle.top * this.pitch + rectangle.left * 4,
        width: rectangle.right - rectangle.left + 1,
        height: rectangle.bottom - rectangle.top + 1,
      };
      copyRasterTextPresentation({...this.textBitmap, ...crop}, {...source.textBitmap, ...crop});
    }
    source.dirty = [];
    this.updateBounds = bounds;
    return bounds !== null;
  }
  dispose(): void {
    this.check();
    if (this.presentationView !== null) {
      Object.defineProperty(this.presentationView, 'storage', {
        value: this.storage.cloneRange(0, this.storage.bytes.length),
      });
      this.presentationView = null;
    }
    this.storage.release();
    this.dirty = [];
    this.disposed = true;
  }
}
