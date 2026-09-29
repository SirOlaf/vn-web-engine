import {serveWorkerPool} from '../../../platform/worker-pool.js';
import {packedImage} from '../../../formats/buriko/compressed-bg.js';
import {decodeBurikoCompressedBgLegacy} from './compressed-bg-wasm.js';
import {decodeBurikoDsc} from './dsc-wasm.js';

/** A snapshot of one resource's stored bytes. */
export interface BurikoResourceDecodeWorkerRequest {
  readonly format: 'dsc' | 'cbg-legacy';
  readonly bytes: Uint8Array;
}

/** DSC output, or a legacy CompressedBG's source header and packed image. */
export interface BurikoResourceDecodeWorkerResponse {
  readonly bytes: Uint8Array;
  readonly sourceHeader?: Uint8Array;
}

// Any failure is reported as a failed job; the host reruns the reference path on its own
// storage, which raises the native error and retains its partial writes.
serveWorkerPool<BurikoResourceDecodeWorkerRequest, BurikoResourceDecodeWorkerResponse>(
  ({format, bytes}) => {
    if (format === 'dsc') {
      const decoded = decodeBurikoDsc(bytes);
      return {response: {bytes: decoded}, transfer: [decoded.buffer]};
    }
    const image = decodeBurikoCompressedBgLegacy(bytes),
      packed = packedImage(image);
    return {
      response: {bytes: packed, sourceHeader: bytes.slice(16, 32)},
      transfer: [packed.buffer],
    };
  },
);
