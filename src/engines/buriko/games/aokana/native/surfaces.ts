import {AokanaSurfaceToneCurves} from './surface-tone-curves.js';
import {applyAokanaBitmapTone} from './bitmap-tone.js';
import {recolorAokanaBitmapAlpha} from './bitmap-recolor.js';
import {mirrorAokanaBitmap} from './bitmap-mirror.js';
import {reduceAokanaBitmapHalf} from './bitmap-reduce.js';
import {stretchCenteredAokanaBitmap} from './bitmap-centered-stretch.js';
import {rotateCenteredAokanaBitmap} from './bitmap-centered-rotation.js';
import {scaleAokanaBitmap} from './bitmap-scale.js';
import {scaleAokanaTrueColorBitmapNearest} from './bitmap-scale-nearest.js';
import {applyAokanaBitmapColorEffect} from './bitmap-color-effects.js';
import {applyAokanaAlphaMask, applyAokanaBitmapMask} from './bitmap-alpha-mask.js';
import {
  AokanaBitmapStorage,
  aokanaBitmapPixelSize,
  bitmapStorage,
  fillAokanaBitmap16,
  fillAokanaBitmap32,
  cropAokanaBitmap,
  aokanaBitmapRectangle,
  intersectAokanaBitmapRectangle,
  translateAokanaBitmapRectangle,
  type AokanaBitmap,
} from './bitmap.js';
import {clearAokanaBitmap, copyAokanaBitmapRows} from './bitmap-copy.js';
import {bitmapRead8, bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';
import {makeAokanaBitmapOpaque, removeAokanaBitmapMatte} from './bitmap-import.js';
import {AokanaBitmapCompositor} from './bitmap-compositor.js';
import {AokanaNativeFonts} from './fonts.js';
import {AokanaDistributedAllocator} from './distributed-processing.js';
import type {AokanaMovieRegistry} from './movie-registry.js';
import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
import {AokanaSurfaceCoefficientTables} from './surface-coefficients.js';
import {convertAokanaBitmapToMask, invertAokanaBitmapMask} from './bitmap-mask-conversion.js';
import {splatAokanaBitmap} from './bitmap-splat.js';
import {
  blendTransformedAokanaBitmap,
  transformAokanaBitmap,
  type AokanaBitmapAffineTransform,
} from './bitmap-affine.js';

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
  readonly toneCurves = new AokanaSurfaceToneCurves();
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

  /** 0327E0 captures source before allocation, then resolves the actual keyed tone table. */
  applyToneCurve(
    destinationIndex: number,
    sourceIndex: number,
    monochrome: number,
    monoLevel: number,
    key: number,
    film: number,
    filmMode: number,
    filmLevel: number,
  ): number {
    const source = this.snapshot(sourceIndex);
    if (source === null) return 0x8000000a;
    if (this.allocate(destinationIndex, source.width, source.height, source.format) === 0)
      return 0x80000009;
    const destination = this.snapshot(destinationIndex)!;
    const curve = this.toneCurves.find(key);
    if (curve === null) return 0x8000000f;
    const result = applyAokanaBitmapTone(
      this.compositor,
      destination,
      source,
      monochrome,
      monoLevel,
      curve,
      film,
      filmMode,
      filmLevel,
    );
    switch (result) {
      case 0:
        return 0;
      case 2:
        return 0x80000013;
      case 3:
        return 0x80000014;
      case 9:
        return 0x80000011;
      case 0x10:
        return 0x8000000f;
      case 0x17:
        return 0x80000015;
      default:
        return 0xffffffff;
    }
  }

  /** 0363B0 snapshots source before allocating floor-sized output; lowers round independently. */
  scaleSurface(
    destinationIndex: number,
    sourceIndex: number,
    scaleX: number,
    scaleY: number,
    sampling: number,
  ): 0 | 1 | 2 | 3 | 4 {
    const source = this.snapshot(sourceIndex);
    if (source === null) return 2;
    if (source.format !== 1 && source.format !== 2) return 3;
    const width = Math.imul(source.width, scaleX) >>> 16;
    const height = Math.imul(source.height, scaleY) >>> 16;
    if (width === 0 || height === 0) return 4;
    if (this.allocate(destinationIndex, width, height, source.format) === 0) return 1;
    const destination = this.snapshot(destinationIndex)!;
    if ((sampling | 0) !== 0) scaleAokanaBitmap(destination, source, scaleX, scaleY);
    else scaleAokanaTrueColorBitmapNearest(destination, source, scaleX, scaleY);
    return 0;
  }

  /** 0361C0 retains original requested dimensions after ignored intersection/crop results. */
  stretchCenteredSurface(
    destinationIndex: number,
    x: number,
    y: number,
    width: number,
    height: number,
    sourceIndex: number,
    sourceX: number,
    sourceY: number,
    sourceWidth: number,
    sourceHeight: number,
  ): number {
    const destination = this.snapshot(destinationIndex);
    if (destination === null) return 1;
    const source = this.snapshot(sourceIndex);
    if (source === null) return 2;
    width >>>= 0;
    height >>>= 0;
    sourceWidth >>>= 0;
    sourceHeight >>>= 0;
    if (width < 2 || height < 2) return 5;
    if (sourceWidth < 2 || sourceHeight < 2) return 6;
    const rectangle = aokanaBitmapRectangle(destination);
    intersectAokanaBitmapRectangle(rectangle, {
      left: x | 0,
      top: y | 0,
      right: (x + width - 1) | 0,
      bottom: (y + height - 1) | 0,
    });
    cropAokanaBitmap(destination, rectangle);
    const quotient = (numerator: number, denominator: number): number => {
      const value = (numerator * 65540) / denominator;
      return !Number.isFinite(value) || value < -(2 ** 63) || value >= 2 ** 63
        ? 0
        : Number(BigInt.asUintN(32, BigInt(Math.trunc(value))));
    };
    const scaleY = quotient(height, sourceHeight),
      scaleX = quotient(width, sourceWidth);
    const result = stretchCenteredAokanaBitmap(
      this.compositor,
      destination,
      source,
      sourceX << 16,
      sourceY << 16,
      sourceWidth << 16,
      sourceHeight << 16,
      scaleX,
      scaleY,
    );
    if (result === 0) return 0;
    if (result === 1) return 8;
    if (result === 0x13) return 7;
    if (result === 0x14) return 6;
    throw new Error('Aokana centered stretch consumes an indeterminate native result');
  }

  /** 036110 preserves the live fourth angle argument through both descriptor snapshots. */
  rotateCenteredSurface(
    destinationIndex: number,
    sourceIndex: number,
    scale: number,
    angle: number,
  ): number {
    const destination = this.snapshot(destinationIndex);
    if (destination === null) return 1;
    const source = this.snapshot(sourceIndex);
    if (source === null) return 2;
    const result = rotateCenteredAokanaBitmap(this.compositor, destination, source, scale, angle);
    if (result === 0) return 0;
    if (result === 1) return 3;
    if (result === 0x13) return 4;
    throw new Error('Aokana centered rotation consumes an indeterminate native result');
  }

  /**0325F0 resolves source before equal-ID rejection, then allocates before mode validation. */
  mirrorSurface(destinationIndex: number, sourceIndex: number, mode: number): number {
    const source = this.snapshot(sourceIndex);
    if (source === null) return 0x8000000a;
    if ((destinationIndex | 0) === (sourceIndex | 0)) return 0x80000009;
    if (this.allocate(destinationIndex, source.width, source.height, source.format) === 0)
      return 0x80000009;
    return mirrorAokanaBitmap(this.snapshot(destinationIndex)!, source, mode);
  }

  /**032C40 preserves checked allocation and the actual reducer's format/write behavior. */
  reduceSurfaceHalf(destinationIndex: number, sourceIndex: number): number {
    const source = this.snapshot(sourceIndex);
    if (source === null) return 0x8000000a;
    if (source.width >>> 0 < 2 || source.height >>> 0 < 2) return 0x80000006;
    if (
      this.allocateChecked(
        destinationIndex,
        (source.width + 1) >>> 1,
        (source.height + 1) >>> 1,
        source.format,
      ) !== 0
    )
      return 0x80000009;
    reduceAokanaBitmapHalf(this.snapshot(destinationIndex)!, source);
    return 0;
  }

  /** Resolves the construction cycle before any movie is attached to a slot. */
  attachMovies(movies: AokanaMovieRegistry): void {
    if (this.movies !== null && this.movies !== movies)
      throw new Error('Aokana surface movie registry is already attached');
    this.movies = movies;
  }
  /** Read-only identity check for lowers that borrow the one attached movie registry. */
  usesMovieRegistry(movies: AokanaMovieRegistry): boolean {
    return this.movies === movies;
  }
  private slot(index: number): SurfaceSlot | null {
    index |= 0;
    return index >= 0 && index < this.capacity ? this.slots[index]! : null;
  }
  /** 1400424e0 does not require a live bitmap. */
  record(index: number): AokanaSurfaceRecord | null {
    return this.slot(index);
  }
  /** 042060 snapshots before allocation and deliberately ignores the conversion status. */
  createMask(destinationIndex: number, sourceIndex: number): 0 | 9 | 10 {
    const source = this.snapshot(sourceIndex);
    if (source === null) return 9;
    if (this.allocate(destinationIndex, source.width, source.height, 3) === 0) return 10;
    convertAokanaBitmapToMask(this.snapshot(destinationIndex)!, source);
    return 0;
  }
  /** 042010 maps the actual format-three inversion result without allocating. */
  invertMask(index: number): 0 | 7 | 11 {
    const bitmap = this.snapshot(index);
    if (bitmap === null) return 11;
    return invertAokanaBitmapMask(bitmap) ? 0 : 7;
  }
  /** 036D40 uses the slot record even when no bitmap is attached. */
  setMetadata(index: number, x: number, y: number): 0 | 1 {
    const record = this.record(index);
    if (record === null) return 0;
    record.metadataX = x | 0;
    record.metadataY = y | 0;
    return 1;
  }
  /** 036D00 loads the pair before committing the caller's QWORD output. */
  getMetadata(output: AokanaBpPointer | null, index: number): 0 | 1 {
    const record = this.record(index);
    if (record === null) return 0;
    const x = record.metadataX,
      y = record.metadataY;
    if (output === null) throw new Error('Aokana surface metadata dereferences a null output');
    const view = pointerView(output, 8);
    view.setInt32(0, x, true);
    view.setInt32(4, y, true);
    return 1;
  }
  /** 036B60 changes matching pixels in the actual descriptor, without damage or locking. */
  replaceColor(index: number, search: number, replacement: number): 0 | 1 | 2 {
    const bitmap = this.snapshot(index);
    if (bitmap === null) return 1;
    if (bitmap.bytesPerPixel !== 4) return 2;
    search >>>= 0;
    replacement >>>= 0;
    if (bitmap.format !== 1 && bitmap.format !== 2) return 0;
    const rgbOnly = bitmap.format === 1 || (search & 0xff000000) === 0;
    for (let y = 0; y < bitmap.height >>> 0; y++)
      for (let x = 0; x < bitmap.width >>> 0; x++) {
        const offset = bitmap.offset + y * bitmap.stride + x * 4;
        const pixel = bitmapRead32(bitmap, offset);
        if (rgbOnly ? (pixel & 0xffffff) === (search & 0xffffff) : pixel === search)
          bitmapWrite32(
            bitmap,
            offset,
            rgbOnly
              ? (bitmap.format === 2 ? pixel & 0xff000000 : 0) | (replacement & 0xffffff)
              : replacement,
          );
      }
    return 0;
  }
  /** 036AD0 clears the DWORD before memmove reads the selected source pixel. */
  readPixel(output: AokanaBpPointer | null, index: number, x: number, y: number): 0 | 1 | 2 | 3 {
    const bitmap = this.snapshot(index);
    if (bitmap === null) return 1;
    const count = bitmap.bytesPerPixel >>> 0;
    if (count > 4) return 2;
    x |= 0;
    y |= 0;
    if (x < 0 || x >= bitmap.width || y < 0 || y >= bitmap.height) return 3;
    if (output === null) throw new Error('Aokana surface pixel query dereferences a null output');
    pointerView(output, 4).setUint32(0, 0, true);
    const backing = bitmap.storage;
    if (backing !== null && backing.bytes.buffer === output.bytes.buffer) {
      const start = output.bytes.byteOffset + output.offset - backing.bytes.byteOffset;
      const first = Math.max(0, start),
        last = Math.min(backing.bytes.length, start + 4);
      if (first < last) backing.written(first, last - first);
    }
    const offset = bitmap.offset + Math.imul(bitmap.stride, y) + (Math.imul(count, x) >>> 0);
    const storage = bitmapStorage(bitmap, offset, count, true);
    output.bytes.set(storage.bytes.subarray(offset, offset + count), output.offset);
    return 0;
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

  /** 0405C0 visits every fixed slot in ascending order after 0802B0.
   * Attached movie retirement begins synchronously; its owner joins completion later. */
  releaseAllForProgram(actor: object = this.allocator.currentActor): void {
    this.allocator.withActor(actor, () => {
      for (let index = 0; index < this.capacity; index++) this.release(index);
    });
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
    initialized?: Uint8Array,
  ): 0 | 1 {
    if (this.allocate(index, width, height, format) === 0) return 0;
    const destination = this.snapshot(index)!;
    if (data === null) throw new Error('Aokana raw bitmap import dereferences a null source');
    const bytesPerPixel = format === 1 ? 3 : destination.bytesPerPixel;
    let stride = Math.imul(bytesPerPixel, width);
    if (alignedRows !== 0) stride = (stride + 3) & ~3;
    const source: AokanaBitmap = {
      storage: AokanaBitmapStorage.tracked(data.bytes, initialized),
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

  /** 035E70 validates descriptors before unsigned scales and attenuation. */
  splatSurface(
    destinationIndex: number,
    sourceIndex: number,
    scaleX: number,
    scaleY: number,
    level: number,
  ): 0 | 1 | 2 | 4 | 5 {
    const destination = this.snapshot(destinationIndex);
    if (destination === null) return 1;
    const source = this.snapshot(sourceIndex);
    if (source === null) return 2;
    if (scaleX >>> 0 > 65536 || scaleY >>> 0 > 65536) return 4;
    if (level >>> 0 > 256) return 5;
    splatAokanaBitmap(destination, source, scaleX, scaleY, level);
    return 0;
  }

  /** 036010/035F10 snapshot both real descriptors before the shared affine operation. */
  transformSurface(
    destinationIndex: number,
    sourceIndex: number,
    transform: AokanaBitmapAffineTransform,
    transparency: number,
    sampling: number,
    blend: boolean,
  ): 0 | 1 | 2 | 3 {
    const destination = this.snapshot(destinationIndex);
    if (destination === null) return 1;
    const source = this.snapshot(sourceIndex);
    if (source === null) return 2;
    const result = (blend ? blendTransformedAokanaBitmap : transformAokanaBitmap)(
      this.compositor,
      destination,
      source,
      transform,
      transparency,
      sampling,
      true,
    );
    if (result === 0) return 0;
    if (result === 0x13) return 3;
    throw new Error('Aokana surface transform reads an unwritten native result');
  }

  /** 0358C0 deliberately ignores intersection/crop results before054C30. */
  recolorSurface(destinationIndex: number, sourceIndex: number, color: number): 0 | 1 | 2 {
    const destination = this.snapshot(destinationIndex);
    if (destination === null) return 1;
    const source = this.snapshot(sourceIndex);
    if (source === null) return 2;
    const rectangle = aokanaBitmapRectangle(destination);
    intersectAokanaBitmapRectangle(rectangle, aokanaBitmapRectangle(source));
    cropAokanaBitmap(destination, rectangle);
    cropAokanaBitmap(source, rectangle);
    recolorAokanaBitmapAlpha(destination, source, color);
    return 0;
  }

  /** 035DF0 requests actual strip-capable054840 and maps its status. */
  applySurfaceColorEffect(
    destinationIndex: number,
    sourceIndex: number,
    selector: number,
    color: number,
    level: number,
  ): 0 | 1 | 2 | 6 {
    const destination = this.snapshot(destinationIndex);
    if (destination === null) return 1;
    const source = this.snapshot(sourceIndex);
    if (source === null) return 2;
    return applyAokanaBitmapColorEffect(
      this.compositor,
      destination,
      source,
      selector,
      color,
      level,
      true,
    ) === 0
      ? 0
      : 6;
  }

  /** 035C90 clips by translated mask bounds and ignores the selected mask kernel status. */
  applySurfaceMask(
    destinationIndex: number,
    maskIndex: number,
    x: number,
    y: number,
  ): 0 | 1 | 2 | 3 {
    const destination = this.snapshot(destinationIndex);
    if (destination === null) return 1;
    const mask = this.snapshot(maskIndex);
    if (mask === null) return 2;
    const rectangle = aokanaBitmapRectangle(destination),
      bounds = aokanaBitmapRectangle(mask);
    translateAokanaBitmapRectangle(bounds, -x | 0, -y | 0);
    if (!intersectAokanaBitmapRectangle(rectangle, bounds)) return 0;
    cropAokanaBitmap(destination, rectangle);
    translateAokanaBitmapRectangle(rectangle, x | 0, y | 0);
    cropAokanaBitmap(mask, rectangle);
    if (mask.format === 2) applyAokanaAlphaMask(destination, destination, mask, 0);
    else if (mask.format === 3) applyAokanaBitmapMask(destination, destination, mask);
    else return 3;
    return 0;
  }

  /** 035990 resolves current metadata only after destination allocation and pixel copying. */
  duplicateSurface(destinationIndex: number, sourceIndex: number): 0 | 1 | 2 {
    const source = this.snapshot(sourceIndex);
    if (source === null) return 2;
    if (this.allocate(destinationIndex, source.width, source.height, source.format) === 0) return 1;
    copyAokanaBitmapRows(this.snapshot(destinationIndex)!, source);
    const sourceRecord = this.record(sourceIndex)!,
      destinationRecord = this.record(destinationIndex)!;
    const x = sourceRecord.metadataX,
      y = sourceRecord.metadataY;
    destinationRecord.metadataX = x;
    destinationRecord.metadataY = y;
    return 0;
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
    if ((destinationFlags | 0) >= 0) destination.storage!.allowNativeHeapReads();
    this.compositor.draw(destination, -x | 0, -y | 0, source, 0x80, 0);
    return 0;
  }
}
