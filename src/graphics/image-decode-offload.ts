import type {DecodedPng, PngDecodeOptions} from '../formats/png/decode.js';
import {WorkerPool} from '../platform/worker-pool.js';
import {beginRuntimeSpan} from '../platform/runtime-performance.js';

/** Named formats use pure byte decoders; MIME types use the browser-owned codec. */
export type ImageDecodeFormat = 'png' | 'artemis-psd' | 'opaque-jpeg' | 'image/webp' | 'image/jpeg';

export interface ImageDecodeRequest {
  readonly format: ImageDecodeFormat;
  readonly bytes: Uint8Array;
  readonly png?: PngDecodeOptions;
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
export function decodeImageOffThread(
  bytes: Uint8Array,
  format: 'png',
  png?: PngDecodeOptions,
): Promise<DecodedPng | null>;
export function decodeImageOffThread(
  bytes: Uint8Array,
  format: Exclude<ImageDecodeFormat, 'png'>,
): Promise<{width: number; height: number; pixels: Uint8Array} | null>;
export async function decodeImageOffThread(
  bytes: Uint8Array,
  format: ImageDecodeFormat,
  png?: PngDecodeOptions,
): Promise<ImageDecodeResponse | null> {
  const workers = decodePool();
  if (!workers.available) return null;
  // Records the time until the decoded image is back, worker queueing included.
  const finish = beginRuntimeSpan(`graphics.decode.${format.replace('/', '-')}`, {
    bytes: bytes.length,
  });
  // A Uint8Array subclass (for example Node Buffer) may implement slice as a borrowed view.
  const snapshot = Uint8Array.from(bytes);
  try {
    return (await workers.run({format, bytes: snapshot, png}, [snapshot.buffer])) ?? null;
  } finally {
    finish?.();
  }
}
