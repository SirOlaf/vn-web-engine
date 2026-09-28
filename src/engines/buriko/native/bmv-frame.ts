import {hostPointer, pointerView} from '../bp/memory.js';
import {decodeBurikoBfFrame, decodeBurikoBfFrameAsync} from './bf-frame.js';
import {bitmapStorage, type BurikoBitmap} from './bitmap.js';
import type {BurikoDistributedProcessing} from './distributed-processing.js';
import {requireBurikoResourceRange} from './bf-entropy.js';
import {HostTaskBudget} from '../../../core/host-task-budget.js';

/** 109270 recognizes the two modern BF movie versions. */
export function validateBurikoBmvHeader(movie: Uint8Array): 0 | 8 | 9 {
  const signature = [
    0x42, 0x46, 0x5f, 0x4d, 0x6f, 0x76, 0x69, 0x65, 0x5f, 0x5f, 0x5f, 0x5f, 0x5f, 0x5f, 0x5f, 0,
  ];
  for (let index = 0; index < signature.length; index++) {
    requireBurikoResourceRange(movie.length, index, 1);
    if (movie[index] !== signature[index]) return 8;
  }
  const version = pointerView(hostPointer(movie, 0x10), 4).getUint32(0, true);
  return (version - 0x10000) >>> 0 <= 1 ? 0 : 9;
}

/** 105F30 uses header width*4, ignoring descriptor stride, at the actual pixel pointer. */
export function decodeBurikoBmvFrameData(
  header: Uint8Array,
  frame: Uint8Array,
  destination: BurikoBitmap,
  processing: BurikoDistributedProcessing,
): 0 {
  const data = pointerView(hostPointer(header), 0x40),
    width = data.getUint32(0x14, true),
    height = data.getUint32(0x18, true),
    depth = data.getUint32(0x1c, true),
    version = data.getUint32(0x10, true),
    extent = Math.imul(Math.imul(width, height), 4) >>> 0,
    storage = bitmapStorage(destination, destination.offset, extent, false);
  requireBurikoResourceRange(header.length, 0x40, 128);
  const surface = {
    bytes: storage.bytes.subarray(destination.offset, destination.offset + extent),
    initialized: storage.initializedRange(destination.offset, extent),
  };
  try {
    decodeBurikoBfFrame(
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

/** Host-cooperative counterpart used by the BMV worker pump. */
export async function decodeBurikoBmvFrameDataAsync(
  header: Uint8Array,
  frame: Uint8Array,
  destination: BurikoBitmap,
  processing: BurikoDistributedProcessing,
  actor = processing.allocator.currentActor,
): Promise<0> {
  const data = pointerView(hostPointer(header), 0x40),
    width = data.getUint32(0x14, true),
    height = data.getUint32(0x18, true),
    depth = data.getUint32(0x1c, true),
    version = data.getUint32(0x10, true),
    extent = Math.imul(Math.imul(width, height), 4) >>> 0,
    storage = bitmapStorage(destination, destination.offset, extent, false);
  requireBurikoResourceRange(header.length, 0x40, 128);
  const surface = {
    bytes: storage.bytes.subarray(destination.offset, destination.offset + extent),
    initialized: storage.initializedRange(destination.offset, extent),
  };
  const budget = new HostTaskBudget();
  const beforeResume = (): void => storage.range(destination.offset, extent, false);
  try {
    beforeResume();
    await decodeBurikoBfFrameAsync(
      frame,
      width,
      height,
      depth,
      header.subarray(0x40, 0xc0),
      processing,
      surface,
      version,
      actor,
      beforeResume,
    );
  } finally {
    for (let cursor = 0; cursor < extent;) {
      if (surface.initialized[cursor] === 0) {
        cursor++;
        if ((cursor & 0x3fff) === 0) {
          const pending = budget.checkpoint();
          if (pending !== undefined) {
            await pending;
            beforeResume();
          }
        }
        continue;
      }
      const start = cursor++;
      while (cursor < extent && surface.initialized[cursor] !== 0) {
        cursor++;
        if ((cursor & 0x3fff) === 0) {
          const pending = budget.checkpoint();
          if (pending !== undefined) {
            await pending;
            beforeResume();
          }
        }
      }
      storage.written(destination.offset + start, cursor - start);
    }
  }
  return 0;
}

/** 1091B0 uses header-relative frame offsets and preserves the decoder's return. */
export function decodeBurikoBmvIndexedFrame(
  movie: Uint8Array,
  frameIndex: number,
  destination: BurikoBitmap,
  processing: BurikoDistributedProcessing,
): number {
  const status = validateBurikoBmvHeader(movie);
  if (status !== 0) return status;
  frameIndex >>>= 0;
  if (frameIndex >= pointerView(hostPointer(movie, 0x28), 4).getUint32(0, true)) return 10;
  const offset = pointerView(hostPointer(movie, 0xc0 + frameIndex * 4), 4).getUint32(0, true);
  requireBurikoResourceRange(movie.length, offset, 0);
  return decodeBurikoBmvFrameData(movie, movie.subarray(offset), destination, processing);
}

/** Indexed, host-cooperative counterpart; validates before allocating or touching pixels. */
export async function decodeBurikoBmvIndexedFrameAsync(
  movie: Uint8Array,
  frameIndex: number,
  destination: BurikoBitmap,
  processing: BurikoDistributedProcessing,
  actor = processing.allocator.currentActor,
): Promise<number> {
  const status = validateBurikoBmvHeader(movie);
  if (status !== 0) return status;
  frameIndex >>>= 0;
  if (frameIndex >= pointerView(hostPointer(movie, 0x28), 4).getUint32(0, true)) return 10;
  const offset = pointerView(hostPointer(movie, 0xc0 + frameIndex * 4), 4).getUint32(0, true);
  requireBurikoResourceRange(movie.length, offset, 0);
  return decodeBurikoBmvFrameDataAsync(
    movie,
    movie.subarray(offset),
    destination,
    processing,
    actor,
  );
}
