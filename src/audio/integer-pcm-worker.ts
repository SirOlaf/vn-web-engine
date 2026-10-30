import {serveWorkerPool} from '../platform/worker-pool.js';
import {
  integerPcmClip,
  type IntegerPcmRequest,
  type IntegerPcmResponse,
} from './integer-pcm-codec.js';

serveWorkerPool<IntegerPcmRequest, IntegerPcmResponse>(async (request) => {
  try {
    const clip = integerPcmClip(request);
    return {response: {clip}, transfer: clip.channels.map((plane) => plane.buffer as ArrayBuffer)};
  } catch (error) {
    return {response: {error: error instanceof Error ? error.message : String(error)}};
  }
});
