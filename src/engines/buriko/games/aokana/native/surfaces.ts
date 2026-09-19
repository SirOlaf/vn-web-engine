import {
  AokanaBitmapStorage,
  aokanaBitmapPixelSize,
  bitmapStorage,
  fillAokanaBitmap16,
  fillAokanaBitmap32,
  cropAokanaBitmap,
  type AokanaBitmap,
} from './bitmap.js';
import {clearAokanaBitmap, copyAokanaBitmapRows} from './bitmap-copy.js';
import {bitmapRead8, bitmapWrite32} from './bitmap-scalar.js';
import {makeAokanaBitmapOpaque, removeAokanaBitmapMatte} from './bitmap-import.js';
import {AokanaBitmapCompositor} from './bitmap-compositor.js';
import {AokanaNativeFonts} from './fonts.js';
import {AokanaDistributedAllocator} from './distributed-processing.js';
import type {AokanaMovieRegistry} from './movie-registry.js';
import type {AokanaBpPointer} from '../bp/memory.js';
import {AokanaSurfaceCoefficientTables} from './surface-coefficients.js';

export interface AokanaSurfaceRecord {
  bitmap: AokanaBitmap | null;
  imageId: number | null;
  movieId: number;
  frame: number;
  metadataX: number;
  metadataY: number;
}
interface SurfaceSlot extends AokanaSurfaceRecord {
  owner: AokanaBitmapStorage | null;
  lockOwner: object | null;
  lockDepth: number;
}

/** Global 1401e8d58's fixed 0x4000-slot table and CMemoryDX ownership. */
export class AokanaSurfaces {
  readonly capacity = 0x4000;
  /** The same eight-record owner used by every sprite/filter coefficient consumer. */
  readonly coefficientTables = new AokanaSurfaceCoefficientTables();
  deviceIndex = 0;
  preserveImageIds = 0;
  private nextImageId = 0;
  private movies: AokanaMovieRegistry | null = null;
  private readonly slots: SurfaceSlot[] = Array.from({length: 0x4000}, () => ({
    owner: null,
    bitmap: null,
    imageId: null,
    movieId: -1,
    frame: -1,
    metadataX: -1,
    metadataY: -1,
    lockOwner: null,
    lockDepth: 0,
  }));
  constructor(
    readonly fonts: AokanaNativeFonts,
    readonly compositor: AokanaBitmapCompositor,
    readonly allocator: AokanaDistributedAllocator,
  ) {}

  /** Resolves the construction cycle before any movie is attached to a slot. */
  attachMovies(movies: AokanaMovieRegistry): void {
    if (this.movies !== null && this.movies !== movies)
      throw new Error('Aokana surface movie registry is already attached');
    this.movies = movies;
  }
  private slot(index: number): SurfaceSlot | null {
    index |= 0;
    return index >= 0 && index < this.capacity ? this.slots[index]! : null;
  }
  /** 1400424e0 does not require a live bitmap. */
  record(index: number): AokanaSurfaceRecord | null {
    return this.slot(index);
  }
  /** 140040500 returns the actual mutable descriptor inside a live slot. */
  descriptor(index: number): AokanaBitmap | null {
    const slot = this.slot(index);
    return slot?.owner ? slot.bitmap : null;
  }
  /** 1400424a0 copies the descriptor while retaining backing-buffer identity. */
  snapshot(index: number): AokanaBitmap | null {
    const bitmap = this.descriptor(index);
    return bitmap === null ? null : {...bitmap};
  }
  /** 1400404d0 returns -1 for an unused or invalid slot. */
  imageId(index: number): number {
    const slot = this.slot(index);
    if (!slot?.owner) return -1;
    if (slot.imageId === null) throw new Error('Aokana surface reads an unwritten native image ID');
    return slot.imageId;
  }

  /** 140040f60 retains its recursive critical section only for a live owner. */
  lock(index: number): 0 | 1 {
    const slot = this.slot(index);
    if (slot === null) return 0;
    const actor = this.allocator.currentActor;
    if (slot.lockOwner !== null && slot.lockOwner !== actor)
      throw new Error(
        'Aokana surface critical section requires its current actor to resume before entry',
      );
    slot.lockOwner = actor;
    slot.lockDepth++;
    if (slot.owner !== null) return 1;
    this.unlock(index);
    return 0;
  }
  /** 140040f20 attempts LeaveCriticalSection for every valid slot. */
  unlock(index: number): 0 | 1 {
    const slot = this.slot(index);
    if (slot === null) return 0;
    if (slot.lockDepth === 0 || slot.lockOwner !== this.allocator.currentActor)
      throw new Error('Aokana surface releases a native critical section it does not own');
    if (--slot.lockDepth === 0) slot.lockOwner = null;
    return 1;
  }

  /** 140042500 increments/preserves ID and destroys the old slot before format validation. */
  allocate(index: number, width: number, height: number, format: number): 0 | 1 {
    const slot = this.slot(index);
    if (slot === null) return 0;
    let id = this.imageId(index);
    if (id === -1 || this.preserveImageIds === 0) {
      id = this.nextImageId;
      this.nextImageId = (id + 1) | 0;
    }
    this.release(index);
    format >>>= 0;
    if (format > 6) {
      if (format !== 7) return 0;
      format = 1;
    }
    width |= 0;
    height |= 0;
    const bytesPerPixel = aokanaBitmapPixelSize(format);
    const stride = Math.imul(bytesPerPixel, width);
    const size = Math.imul(stride, height) >>> 0;
    let owner: AokanaBitmapStorage;
    try {
      owner = new AokanaBitmapStorage(new Uint8Array(size), false);
    } catch (error) {
      if (error instanceof RangeError) return 0;
      throw error;
    }
    // Verified CRT _aligned_malloc allocates size+23 even for requested size zero.
    slot.owner = owner;
    slot.bitmap = {storage: owner, offset: 0, stride, width, height, format, bytesPerPixel};
    slot.imageId = id;
    return 1;
  }

  /** 140042630 frees owner under lock, unlocks, then destroys an attached movie. */
  release(index: number): 0 | 1 {
    const slot = this.slot(index);
    if (slot === null || this.lock(index) === 0) return 0;
    slot.owner!.release();
    slot.owner = null;
    this.unlock(index);
    if (slot.movieId !== -1) {
      if (this.movies === null)
        throw new Error('Aokana movie was attached before its concrete registry');
      this.movies.remove(slot.movieId);
      slot.movieId = -1;
      slot.frame = -1;
    }
    slot.metadataX = -1;
    slot.metadataY = -1;
    return 1;
  }

  /** 140042440/14003e5a0: nonzero colors dispatch by native bitmap format. */
  fill(index: number, color: number): 0 | 1 {
    const bitmap = this.snapshot(index);
    if (bitmap === null) return 0;
    color >>>= 0;
    if (color === 0) clearAokanaBitmap(bitmap);
    else if (bitmap.format === 0) fillAokanaBitmap16(bitmap, color);
    else if (bitmap.format === 1 || bitmap.format === 2)
      fillAokanaBitmap32(bitmap, bitmap.format === 1 ? color & 0xffffff : color);
    else if (bitmap.format === 3)
      for (let y = 0; y < bitmap.height >>> 0; y++) {
        const offset = bitmap.offset + y * bitmap.stride;
        const storage = bitmapStorage(bitmap, offset, bitmap.width >>> 0, false);
        storage.bytes.fill(color & 255, offset, offset + (bitmap.width >>> 0));
        storage.written(offset, bitmap.width >>> 0);
      }
    return 1;
  }

  /** 0369E0 validates the wrapping DWORD pixel product before the actual slot operation. */
  allocateChecked(index: number, width: number, height: number, format: number): number {
    if (index >>> 0 >= this.capacity) return 0x80000007;
    if ((width | 0) === 0 || (height | 0) === 0 || Math.imul(width, height) >>> 0 > 0x4000000)
      return 0x80000006;
    return this.allocate(index, width, height, format) === 0 ? 0x80000011 : 0;
  }

  /** 042280 changes the live descriptor in place; 036A80 translates its status. */
  convertFormat(index: number, format: number): 0 | 1 | 2 {
    const bitmap = this.descriptor(index);
    if (bitmap === null) return 1;
    format |= 0;
    if (bitmap.format === format) return 0;
    if (bitmap.format === 1 && format === 2) {
      bitmap.format = 2;
      makeAokanaBitmapOpaque(bitmap);
      return 0;
    }
    if (bitmap.format === 2 && format === 1) {
      bitmap.format = 1;
      return 0;
    }
    return 2;
  }

  /** 0422F0: raw RGB is packed BGR24, while other formats retain native row-copy order. */
  importRaw(
    index: number,
    width: number,
    height: number,
    format: number,
    data: AokanaBpPointer | null,
    metadata: readonly [number, number] | null = null,
    alignedRows = 0,
  ): 0 | 1 {
    if (this.allocate(index, width, height, format) === 0) return 0;
    const destination = this.snapshot(index)!;
    if (data === null) throw new Error('Aokana raw bitmap import dereferences a null source');
    const bytesPerPixel = format === 1 ? 3 : destination.bytesPerPixel;
    let stride = Math.imul(bytesPerPixel, width);
    if (alignedRows !== 0) stride = (stride + 3) & ~3;
    const source: AokanaBitmap = {
      storage: new AokanaBitmapStorage(data.bytes, true),
      offset: data.offset,
      stride,
      width: width | 0,
      height: height | 0,
      format: format | 0,
      bytesPerPixel,
    };
    if (format === 1) {
      for (let y = 0; y < height >>> 0; y++)
        for (let x = 0; x < width >>> 0; x++) {
          const offset = source.offset + y * source.stride + x * 3;
          // Native reads G,R,B before committing the one destination DWORD.
          const green = bitmapRead8(source, offset + 1),
            red = bitmapRead8(source, offset + 2),
            blue = bitmapRead8(source, offset);
          bitmapWrite32(
            destination,
            destination.offset + (y * width + x) * 4,
            blue | (green << 8) | (red << 16),
          );
        }
    } else copyAokanaBitmapRows(destination, source);
    removeAokanaBitmapMatte(destination, this.compositor.importMatteColor);
    if (metadata !== null) {
      const record = this.record(index)!;
      record.metadataX = metadata[0] | 0;
      record.metadataY = metadata[1] | 0;
    }
    return 1;
  }

  /** 0368C0 resolves destination before source, then maps the complete compositor result. */
  drawSurface(
    destinationIndex: number,
    x: number,
    y: number,
    sourceIndex: number,
    mode: number,
    opacity: number,
  ): number {
    const destination = this.snapshot(destinationIndex);
    if (destination === null) return 1;
    const source = this.snapshot(sourceIndex);
    if (source === null) return 2;
    const result = this.compositor.draw(destination, x, y, source, mode, opacity);
    return [0, 3, 4, 5, 6][result] ?? 7;
  }

  /** 035B50 clips the source crop without adding the clipped-away offset to destination X/Y. */
  copyRegion(
    destinationIndex: number,
    x: number,
    y: number,
    sourceIndex: number,
    sourceX: number,
    sourceY: number,
    width: number,
    height: number,
  ): 0 | 1 | 2 | 3 {
    const destination = this.snapshot(destinationIndex);
    if (destination === null) return 1;
    const source = this.snapshot(sourceIndex);
    if (source === null) return 2;
    if ((width | 0) === 0 || (height | 0) === 0) return 3;
    if (
      cropAokanaBitmap(source, {
        left: sourceX | 0,
        top: sourceY | 0,
        right: (sourceX + width - 1) | 0,
        bottom: (sourceY + height - 1) | 0,
      })
    )
      this.compositor.draw(destination, x, y, source, 0x80, 0);
    return 0;
  }

  /** 035A60 keeps the source descriptor before creating the new cropped destination slot. */
  extractRegion(
    destinationFlags: number,
    sourceIndex: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): 0 | 1 | 2 | 3 {
    const source = this.snapshot(sourceIndex);
    if (source === null) return 2;
    if ((width | 0) === 0 || (height | 0) === 0) return 3;
    const index = destinationFlags & 0x7fffffff;
    if (this.allocate(index, width, height, source.format) === 0) return 1;
    if ((destinationFlags | 0) < 0) this.fill(index, 0);
    const destination = this.snapshot(index)!;
    this.compositor.draw(destination, -x | 0, -y | 0, source, 0x80, 0);
    return 0;
  }
}
