import {pointerView} from '../bp/memory.js';
import {decodeAokanaBfFrame} from './bf-frame.js';
import {bitmapStorage, type AokanaBitmap} from './bitmap.js';
import type {AokanaDistributedProcessing} from './distributed-processing.js';
import {requireAokanaResourceRange} from './bf-entropy.js';

/** 109270 recognizes the two modern BF movie versions. */
export function validateAokanaBmvHeader(movie: Uint8Array): 0 | 8 | 9 {
  const signature = [
    0x42, 0x46, 0x5f, 0x4d, 0x6f, 0x76, 0x69, 0x65, 0x5f, 0x5f, 0x5f, 0x5f, 0x5f, 0x5f, 0x5f, 0,
  ];
  for (let index = 0; index < signature.length; index++) {
    requireAokanaResourceRange(movie.length, index, 1);
    if (movie[index] !== signature[index]) return 8;
  }
  const version = pointerView({bytes: movie, offset: 0x10}, 4).getUint32(0, true);
  return (version - 0x10000) >>> 0 <= 1 ? 0 : 9;
}

/** 105F30 uses header width*4, ignoring descriptor stride, at the actual pixel pointer. */
export function decodeAokanaBmvFrameData(
  header: Uint8Array,
  frame: Uint8Array,
  destination: AokanaBitmap,
  processing: AokanaDistributedProcessing,
): 0 {
  const data = pointerView({bytes: header, offset: 0}, 0x40),
    width = data.getUint32(0x14, true),
    height = data.getUint32(0x18, true),
    depth = data.getUint32(0x1c, true),
    version = data.getUint32(0x10, true),
    extent = Math.imul(Math.imul(width, height), 4) >>> 0,
    storage = bitmapStorage(destination, destination.offset, extent, false);
  requireAokanaResourceRange(header.length, 0x40, 128);
  const surface = {
    bytes: storage.bytes.subarray(destination.offset, destination.offset + extent),
    initialized: storage.initializedRange(destination.offset, extent),
  };
  try {
    decodeAokanaBfFrame(
      frame,
      width,
      height,
      depth,
      header.subarray(0x40, 0xc0),
      processing,
      surface,
      version,
    );
  } finally {
    for (let cursor = 0; cursor < extent;) {
      if (surface.initialized[cursor] === 0) {
        cursor++;
        continue;
      }
      const start = cursor++;
      while (cursor < extent && surface.initialized[cursor] !== 0) cursor++;
      storage.written(destination.offset + start, cursor - start);
    }
  }
  return 0;
}

/** 1091B0 uses header-relative frame offsets and preserves the decoder's return. */
export function decodeAokanaBmvIndexedFrame(
  movie: Uint8Array,
  frameIndex: number,
  destination: AokanaBitmap,
  processing: AokanaDistributedProcessing,
): number {
  const status = validateAokanaBmvHeader(movie);
  if (status !== 0) return status;
  frameIndex >>>= 0;
  if (frameIndex >= pointerView({bytes: movie, offset: 0x28}, 4).getUint32(0, true)) return 10;
  const offset = pointerView({bytes: movie, offset: 0xc0 + frameIndex * 4}, 4).getUint32(0, true);
  requireAokanaResourceRange(movie.length, offset, 0);
  return decodeAokanaBmvFrameData(movie, movie.subarray(offset), destination, processing);
}
