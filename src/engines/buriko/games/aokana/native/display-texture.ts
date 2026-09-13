import {AokanaBitmapStorage, type AokanaBitmapRectangle} from './bitmap.js';
import {aokanaStartupCpuLog} from './startup-budget.js';

export type AokanaDisplayTextureFormat = 21 | 22; // A8R8G8B8 / X8R8G8B8.
export interface AokanaLockedDisplayTexture {
  storage: AokanaBitmapStorage;
  offset: number;
  pitch: number;
}

/** b2d20 uses the native logarithm to ceil each positive DWORD dimension to a power of two. */
export function aokanaDisplayTextureSize(width: number, height: number): readonly [number, number] {
  const divisor = aokanaStartupCpuLog(2);
  const dimension = (value: number): number => {
    const ratio = aokanaStartupCpuLog(value) / divisor;
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
export class AokanaDisplayTexture {
  readonly storage: AokanaBitmapStorage;
  readonly pitch: number;
  private locked = false;
  private disposed = false;
  private dirty: AokanaBitmapRectangle[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
    readonly format: AokanaDisplayTextureFormat,
  ) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1)
      throw new RangeError('Aokana display texture dimensions must be positive integers');
    this.pitch = width * 4;
    this.storage = new AokanaBitmapStorage(new Uint8Array(this.pitch * height), true);
    this.addDirtyRectangle({left: 0, top: 0, right: width - 1, bottom: height - 1});
  }
  private check(): void {
    if (this.disposed) throw new Error('Aokana display texture is no longer available');
  }
  /** LockRect(0,NULL,D3DLOCK_NO_DIRTY_UPDATE); no automatic dirty-region insertion. */
  lock(): AokanaLockedDisplayTexture | null {
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
      throw new RangeError('Aokana logical image exceeds its display texture');
    for (let y = 0; y < height; y++)
      this.storage.bytes.fill(0, y * this.pitch, y * this.pitch + width * 4);
    this.addDirtyRectangle({left: 0, top: 0, right: width - 1, bottom: height - 1});
  }
  /** AddDirtyRect's exclusive right/bottom are converted at the native caller boundary. */
  addDirtyRectangle(rectangle: AokanaBitmapRectangle): void {
    this.check();
    const clipped = {
      left: Math.max(0, rectangle.left | 0),
      top: Math.max(0, rectangle.top | 0),
      right: Math.min(this.width - 1, rectangle.right | 0),
      bottom: Math.min(this.height - 1, rectangle.bottom | 0),
    };
    if (clipped.left <= clipped.right && clipped.top <= clipped.bottom) this.dirty.push(clipped);
  }
  /** UpdateTexture copies current dirty rows and clears the source's dirty region. */
  updateFrom(source: AokanaDisplayTexture): void {
    this.check();
    source.check();
    if (
      this.width !== source.width ||
      this.height !== source.height ||
      this.format !== source.format
    )
      throw new Error('Aokana display textures have incompatible update descriptors');
    for (const rectangle of source.dirty)
      for (let y = rectangle.top; y <= rectangle.bottom; y++) {
        const offset = y * this.pitch + rectangle.left * 4;
        const length = (rectangle.right - rectangle.left + 1) * 4;
        source.storage.range(offset, length, true);
        this.storage.bytes.set(source.storage.bytes.subarray(offset, offset + length), offset);
      }
    source.dirty = [];
  }
  dispose(): void {
    this.check();
    this.storage.release();
    this.dirty = [];
    this.disposed = true;
  }
}
