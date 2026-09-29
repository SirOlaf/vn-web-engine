import {serveWorkerPool} from '../platform/worker-pool.js';
import {decodePng} from '../formats/png/decode.js';
import {decodeBrowserImage} from './browser-image.js';
import type {ImageDecodeRequest, ImageDecodeResponse} from './image-decode-offload.js';

// Failures are reported as failed jobs; the host reruns the in-thread decoder, which raises
// the original error.
serveWorkerPool<ImageDecodeRequest, ImageDecodeResponse>(async ({format, bytes}) => {
  const image = format === 'png' ? await decodePng(bytes) : await decodeBrowserImage(bytes, format);
  const transfer: Transferable[] = [image.pixels.buffer];
  const indices = (image as {indices?: Uint8Array}).indices;
  if (indices) transfer.push(indices.buffer);
  return {response: image, transfer};
});
