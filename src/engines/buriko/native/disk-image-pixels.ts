import type {BurikoBitmap, BurikoBitmapStorage} from './bitmap.js';
import {BurikoSurfaces} from './surfaces.js';

export type BurikoGdiInputPixelFormat = 0x21808 | 0x26200a | 0x30803;
export type BurikoGdiLockPixelFormat = 0x26200a | 0x30803;

export interface BurikoDiskImportSelection {
  readonly mode: 1 | 2 | 3;
  readonly inputPixelFormat: BurikoGdiInputPixelFormat;
  readonly lockPixelFormat: BurikoGdiLockPixelFormat;
  readonly surfaceFormat: 2 | 3;
  readonly finalFormat: 1 | 2 | 3;
}

/** A codec host's synchronous LockBits result. Scan0 addresses the first logical
 * row; a negative stride walks toward lower addresses for subsequent rows. */
export interface BurikoGdiLockedPixels {
  readonly bytes: Uint8Array;
  readonly scan0Offset: number;
  readonly stride: number;
  readonly width: number;
  readonly height: number;
  readonly pixelFormat: BurikoGdiLockPixelFormat;
}

/** Borrowed Scan0 view. The caller must finish using it before its surface can change. */
export interface BurikoGdiScan0Pixels {
  readonly descriptor: BurikoBitmap;
  readonly storage: BurikoBitmapStorage;
  readonly scan0Offset: number;
  readonly scan0Stride: number;
  readonly pixelFormat: 0x22009 | 0x26200a;
}

/** Pixel transfer only; file codecs, GDI+ status, and 90:C4/C5 admission remain separate. */
export class BurikoDiskImagePixels {
  constructor(readonly surfaces: BurikoSurfaces) {}

  /** C0240 selects the source format before C0040 requests LockBits. */
  selectImport(rawMode: number, sourcePixelFormat: number): BurikoDiskImportSelection | null {
    let mode = rawMode | 0;
    if (mode === -1) {
      if (sourcePixelFormat === 0x21808) mode = 1;
      else if (sourcePixelFormat === 0x26200a) mode = 2;
      else if (sourcePixelFormat === 0x30803) mode = 3;
      else return null;
    }
    if (mode !== 1 && mode !== 2 && mode !== 3)
      throw new RangeError('Buriko disk image mode has no defined pixel format');
    const inputPixelFormat = [0, 0x21808, 0x26200a, 0x30803][mode] as BurikoGdiInputPixelFormat;
    return {
      mode,
      inputPixelFormat,
      lockPixelFormat: mode === 3 ? 0x30803 : 0x26200a,
      surfaceFormat: mode === 3 ? 3 : 2,
      finalFormat: mode,
    };
  }

  /** 036D80 imports packed or DWORD-aligned rows, then mode 1 applies 036A80. */
  importLocked(
    index: number,
    selection: BurikoDiskImportSelection,
    frame: BurikoGdiLockedPixels,
  ): 0 | 1 {
    const pixelSize = selection.lockPixelFormat === 0x30803 ? 1 : 4;
    if (
      frame.pixelFormat !== selection.lockPixelFormat ||
      !Number.isSafeInteger(frame.width) ||
      !Number.isSafeInteger(frame.height) ||
      frame.width <= 0 ||
      frame.height <= 0 ||
      frame.width > Math.floor(0x7ffffffc / pixelSize) ||
      !Number.isSafeInteger(frame.scan0Offset) ||
      frame.scan0Offset < 0 ||
      !Number.isSafeInteger(frame.stride) ||
      frame.stride === 0
    )
      throw new RangeError('Buriko disk image LockBits layout is unsupported');
    const packedStride = frame.width * pixelSize;
    const alignedStride = (packedStride + 3) & ~3;
    if (
      (Math.abs(frame.stride) !== packedStride && Math.abs(frame.stride) !== alignedStride) ||
      frame.scan0Offset + Math.min(0, frame.stride * (frame.height - 1)) < 0 ||
      frame.scan0Offset + Math.max(0, frame.stride * (frame.height - 1)) + packedStride >
        frame.bytes.length
    )
      throw new RangeError('Buriko disk image LockBits layout is unsupported');
    let source = frame.bytes;
    let scan0Offset = frame.scan0Offset;
    if (frame.stride < 0) {
      // importRaw's source descriptor has a positive row stride. Normalize only
      // the borrowed LockBits view, preserving its logical row order and padding.
      const positiveStride = -frame.stride;
      source = new Uint8Array(positiveStride * frame.height);
      for (let row = 0; row < frame.height; row++)
        source.set(
          frame.bytes.subarray(
            frame.scan0Offset + row * frame.stride,
            frame.scan0Offset + row * frame.stride + packedStride,
          ),
          row * positiveStride,
        );
      scan0Offset = 0;
    }
    const imported = this.surfaces.importRaw(
      index,
      frame.width,
      frame.height,
      selection.surfaceFormat,
      {bytes: source, offset: scan0Offset},
      null,
      Math.abs(frame.stride) === alignedStride ? 1 : 0,
    );
    if (imported === 0 || selection.mode !== 1) return imported;
    return this.surfaces.convertFormat(index, 1) === 0 ? 1 : 0;
  }

  /** BFD40 snapshots the descriptor but passes the original backing to BitmapFromScan0. */
  prepareScan0(index: number): BurikoGdiScan0Pixels | null {
    const descriptor = this.surfaces.snapshot(index);
    if (descriptor === null || descriptor.storage === null) return null;
    const pixelFormat =
      descriptor.format === 1 || descriptor.format === 7
        ? 0x22009
        : descriptor.format === 2
          ? 0x26200a
          : null;
    if (pixelFormat === null) return null;
    const scan0Stride = descriptor.bytesPerPixel * descriptor.width;
    descriptor.storage.range(descriptor.offset, scan0Stride * descriptor.height, true);
    return {
      descriptor,
      storage: descriptor.storage,
      scan0Offset: descriptor.offset,
      scan0Stride,
      pixelFormat,
    };
  }
}
