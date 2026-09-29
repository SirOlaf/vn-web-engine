import {
  decodeVorbisChunks,
  decodeVorbisFile,
  VorbisDecodeError,
  type VorbisPcm,
  type VorbisStreamCallbacks,
  type VorbisStreamOpen,
  type VorbisStreamSummary,
} from './vorbis-codec.js';
import {WorkerPool} from '../platform/worker-pool.js';
export {VorbisDecodeError};
export type {VorbisPcm, VorbisStreamCallbacks, VorbisStreamOpen, VorbisStreamSummary};

export type VorbisDecodeResponse = {pcm: VorbisPcm} | {error: string; encodedDataError: boolean};

let pool: WorkerPool<Uint8Array, VorbisDecodeResponse> | null = null;

/**
 * Decodes on reused module workers; no browser codec, device sample rate or audio graph.
 * A fresh worker per job reloaded and recompiled libvorbis each time, which took longer
 * than decoding a short voice line. Without workers, decoding runs in-thread.
 */
export async function decodeVorbis(bytes: Uint8Array): Promise<VorbisPcm> {
  if (typeof Worker === 'undefined') return decodeVorbisFile(bytes);
  pool ??= new WorkerPool(
    () => new Worker(new URL('./vorbis-worker.js', import.meta.url), {type: 'module'}),
  );
  // Keep the caller's encoded bytes intact, as with other asynchronous decoders.
  const input = bytes.slice();
  const data = await pool.run(input, [input.buffer]);
  if (data === undefined) {
    if (pool.available) throw new Error('Vorbis decoder worker failed');
    return decodeVorbisFile(bytes);
  }
  if ('pcm' in data) return data.pcm;
  throw data.encodedDataError ? new VorbisDecodeError(data.error) : new Error(data.error);
}

export interface VorbisStreamRequest {
  readonly bytes: Uint8Array;
  readonly firstFrames: number;
  readonly chunkFrames: number;
}
export type VorbisStreamMessage =
  | {readonly kind: 'open'; readonly open: VorbisStreamOpen}
  | {readonly kind: 'chunk'; readonly planes: Float32Array[]; readonly frames: number}
  | {readonly kind: 'done'; readonly summary: VorbisStreamSummary}
  | {readonly kind: 'error'; readonly error: string; readonly encodedDataError: boolean};

/** Handle for a stream in progress; `cancel` stops delivering chunks and frees its worker. */
export interface VorbisStream {
  readonly done: Promise<VorbisStreamSummary>;
  cancel(): void;
}

const idleStreamWorkers: Worker[] = [];

/**
 * Decodes like `decodeVorbis`, reporting the header and then consecutive untrimmed PCM chunks
 * in order (see `decodeVorbisChunks`) before `done` settles. Workers are reused between
 * streams; without workers, decoding runs in-thread.
 */
export function streamVorbis(
  bytes: Uint8Array,
  firstFrames: number,
  chunkFrames: number,
  callbacks: VorbisStreamCallbacks,
): VorbisStream {
  if (typeof Worker === 'undefined') {
    let cancelled = false;
    return {
      done: decodeVorbisChunks(bytes, firstFrames, chunkFrames, {
        onOpen: (open) => {
          if (!cancelled) callbacks.onOpen?.(open);
        },
        onChunk: (planes, frames) => {
          if (!cancelled) callbacks.onChunk(planes, frames);
        },
      }),
      cancel: () => {
        cancelled = true;
      },
    };
  }
  const worker =
    idleStreamWorkers.pop() ??
    new Worker(new URL('./vorbis-stream-worker.js', import.meta.url), {type: 'module'});
  let settled = false;
  let cancel = (): void => {};
  const done = new Promise<VorbisStreamSummary>((resolve, reject) => {
    const finish = (reuse: boolean): void => {
      settled = true;
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      if (reuse && idleStreamWorkers.length < 2) idleStreamWorkers.push(worker);
      else worker.terminate();
    };
    cancel = () => {
      if (settled) return;
      finish(false);
      reject(new DOMException('Vorbis stream was cancelled', 'AbortError'));
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish(false);
      reject(new Error(event.message || 'Vorbis decoder worker failed'));
    };
    worker.onmessageerror = () => {
      finish(false);
      reject(new Error('Vorbis decoder result could not be transferred'));
    };
    worker.onmessage = ({data}: MessageEvent<VorbisStreamMessage>) => {
      if (data.kind === 'open') callbacks.onOpen?.(data.open);
      else if (data.kind === 'chunk') callbacks.onChunk(data.planes, data.frames);
      else if (data.kind === 'done') {
        finish(true);
        resolve(data.summary);
      } else {
        finish(true);
        reject(data.encodedDataError ? new VorbisDecodeError(data.error) : new Error(data.error));
      }
    };
    // Keep the caller's encoded bytes intact, as with other asynchronous decoders.
    const input = bytes.slice();
    worker.postMessage({bytes: input, firstFrames, chunkFrames} satisfies VorbisStreamRequest, [
      input.buffer,
    ]);
  });
  return {done, cancel: () => cancel()};
}
