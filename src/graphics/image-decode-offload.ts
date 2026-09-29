import type {DecodedPng} from '../formats/png/decode.js';
import {WorkerPool} from '../platform/worker-pool.js';

/** `png` uses the engine's PNG decoder; a MIME type uses the browser codec (`decodeBrowserImage`). */
export type ImageDecodeFormat = 'png' | 'image/webp' | 'image/jpeg';

export interface ImageDecodeRequest {
  readonly format: ImageDecodeFormat;
  readonly bytes: Uint8Array;
}

export type ImageDecodeResponse =
  DecodedPng | {readonly width: number; readonly height: number; readonly pixels: Uint8Array};

let pool: WorkerPool<ImageDecodeRequest, ImageDecodeResponse> | null = null;

function decodePool() {
  return (pool ??= new WorkerPool(
    () => new Worker(new URL('./image-decode-worker.js', import.meta.url), {type: 'module'}),
  ));
}

/**
 * Decodes a snapshot of `bytes` on a worker, so large images never block the page. Resolves
 * null when the caller must decode in-thread: workers are unavailable (including non-browser
 * hosts) or the decode failed, in which case the in-thread decoder raises the original error.
 * Worker results are identical to the in-thread decoders'.
 */
export function decodeImageOffThread(bytes: Uint8Array, format: 'png'): Promise<DecodedPng | null>;
export function decodeImageOffThread(
  bytes: Uint8Array,
  format: Exclude<ImageDecodeFormat, 'png'>,
): Promise<{width: number; height: number; pixels: Uint8Array} | null>;
export async function decodeImageOffThread(
  bytes: Uint8Array,
  format: ImageDecodeFormat,
): Promise<ImageDecodeResponse | null> {
  const workers = decodePool();
  if (!workers.available) return null;
  const snapshot = bytes.slice();
  return (await workers.run({format, bytes: snapshot}, [snapshot.buffer])) ?? null;
}
