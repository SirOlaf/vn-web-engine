import {viewsOverlap} from '../../../core/binary.js';
import {signature, view, type BurikoBorrowedBytes} from '../../../formats/buriko/binary.js';
import {
  publishCompressedBgLegacyAsync,
  type BurikoImage,
  type BurikoImageDestination,
} from '../../../formats/buriko/compressed-bg.js';
import {beginRuntimeSpan, recordRuntimeMetric} from '../../../platform/runtime-performance.js';
import {WorkerPool} from '../../../platform/worker-pool.js';
import type {
  BurikoResourceDecodeWorkerRequest,
  BurikoResourceDecodeWorkerResponse,
} from './resource-decode-worker.js';

/** Smaller outputs decode in-thread, where a worker round trip would outweigh the decode. */
const OFFLOAD_MIN_OUTPUT_BYTES = 256 * 1024;

let enabled = true;
let pool: WorkerPool<BurikoResourceDecodeWorkerRequest, BurikoResourceDecodeWorkerResponse> | null =
  null;

/** `?decode-worker=0` keeps every resource decode on the main thread, for A/B captures. */
export function setBurikoDecodeWorkersEnabled(value: boolean): void {
  enabled = value;
}

function decodePool() {
  return (pool ??= new WorkerPool(
    () => new Worker(new URL('./resource-decode-worker.js', import.meta.url), {type: 'module'}),
  ));
}

async function decodeOffThread(
  format: BurikoResourceDecodeWorkerRequest['format'],
  stored: Uint8Array,
): Promise<BurikoResourceDecodeWorkerResponse | undefined> {
  const workers = decodePool();
  if (!workers.available) return undefined;
  const bytes = stored.slice(),
    finish = beginRuntimeSpan(`buriko.decode.${format}.worker`);
  const response = await workers.run({format, bytes}, [bytes.buffer]);
  finish?.({inputBytes: bytes.length, success: response !== undefined});
  recordRuntimeMetric(`buriko.decode.${format}.worker-applied`, Number(response !== undefined));
  return response;
}

/**
 * DSC 1.00 output decoded by a worker from a snapshot of `stored`, or null when the caller
 * must run `decodeBurikoDsc` itself: small outputs, unavailable workers, and every decoder
 * failure, whose native error the in-thread decoder raises. Ineligible resources return null
 * synchronously, so in-thread decoding keeps its original timing.
 */
export function decodeBurikoDscOffThread(
  stored: Uint8Array,
  size: number,
): Promise<Uint8Array | null> | null {
  if (!enabled || size < OFFLOAD_MIN_OUTPUT_BYTES || !decodePool().available) return null;
  return decodeOffThread('dsc', stored).then((response) => response?.bytes ?? null);
}

/**
 * Legacy CompressedBG decoding by a worker from a snapshot of the source, then published into
 * `destination` in the reference order (`publishCompressedBgLegacyAsync`). Returns null before
 * any destination write when the caller must run the in-thread decoder instead: small or
 * empty images, depths the Wasm stages do not accept, overlapping pixel and initialization
 * views, unavailable workers, and every decoder failure. Ineligible images return null
 * synchronously.
 *
 * Native worker threads decode concurrently with the script. A snapshot decode matches the
 * interleaving in which script writes to the source or to published rows land after the
 * native worker has read them.
 */
export function decodeBurikoCompressedBgLegacyOffThread(
  source: BurikoBorrowedBytes,
  destination?: BurikoImageDestination,
  beforeResume?: () => void,
): Promise<BurikoImage | null> | null {
  if (!enabled || !decodePool().available) return null;
  const stored = source.bytes;
  if (stored.length < 48 || !signature(stored, 'CompressedBG___\0')) return null;
  const header = view(stored),
    width = header.getUint16(16, true),
    height = header.getUint16(18, true),
    depth = header.getUint16(20, true);
  if (depth !== 8 && depth !== 24 && depth !== 32) return null;
  if (width * height * (depth === 24 ? 4 : depth >>> 3) < OFFLOAD_MIN_OUTPUT_BYTES) return null;
  if (destination !== undefined && viewsOverlap(destination.bytes, destination.initialized))
    return null;
  return decodeOffThread('cbg-legacy', stored).then(async (decoded) => {
    if (decoded?.sourceHeader === undefined) return null;
    const finish = beginRuntimeSpan('buriko.decode.cbg-legacy.publish');
    try {
      return await publishCompressedBgLegacyAsync(
        {sourceHeader: decoded.sourceHeader, packed: decoded.bytes},
        destination,
        beforeResume,
      );
    } finally {
      finish?.({outputBytes: decoded.bytes.length});
    }
  });
}
