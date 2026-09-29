import {decodeVorbisFile, VorbisDecodeError, type VorbisPcm} from './vorbis-codec.js';
import {WorkerPool} from '../platform/worker-pool.js';
export {VorbisDecodeError};
export type {VorbisPcm};

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
