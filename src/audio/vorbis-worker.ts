import {decodeVorbisFile, VorbisDecodeError} from './vorbis-codec.js';
import type {VorbisDecodeResponse} from './vorbis-decoder.js';
import {serveWorkerPool} from '../platform/worker-pool.js';

// Pool workers stay alive between jobs, so libvorbis loads and compiles once per worker.
serveWorkerPool<Uint8Array, VorbisDecodeResponse>(async (data) => {
  try {
    const pcm = await decodeVorbisFile(data);
    return {
      response: {pcm},
      transfer: [...new Set(pcm.planes.map((plane) => plane.buffer as ArrayBuffer))],
    };
  } catch (error) {
    return {
      response: {
        error: error instanceof Error ? error.message : String(error),
        encodedDataError: error instanceof VorbisDecodeError,
      },
    };
  }
});
