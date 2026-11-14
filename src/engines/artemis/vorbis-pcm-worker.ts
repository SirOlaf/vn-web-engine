import {serveWorkerPool} from '../../platform/worker-pool.js';
import {
  decodeArtemisVorbisBytes,
  type ArtemisVorbisRequest,
  type ArtemisVorbisResponse,
} from './vorbis-byte-decode.js';

serveWorkerPool<ArtemisVorbisRequest, ArtemisVorbisResponse>(async (request) => {
  try {
    const pcm = await decodeArtemisVorbisBytes(request);
    return {response: {pcm}, transfer: pcm ? [pcm.bytes.buffer as ArrayBuffer] : []};
  } catch (error) {
    return {response: {error: error instanceof Error ? error.message : String(error)}};
  }
});
