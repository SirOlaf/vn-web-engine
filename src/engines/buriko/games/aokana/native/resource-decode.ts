import {decodeDsc} from '../../../../../formats/buriko/dsc.js';
import {decodeCompressedBgLegacy, packedImage} from '../../../../../formats/buriko/compressed-bg.js';
import {signature} from '../../../../../formats/buriko/binary.js';
import {decodeAokanaCompressedBgV2} from './compressed-bg-v2.js';
import {AokanaUndefinedResourceRead, AokanaResourceCodecException} from './resource-memory.js';
import {requireAokanaResourceRange} from './bf-entropy.js';
import {AokanaDistributedProcessing} from './distributed-processing.js';
export {AokanaUndefinedResourceRead} from './resource-memory.js';

export type AokanaResourceDecodeStatus = 0 | 2 | 3 | 5 | 6;
export interface AokanaResourceDecodeResult {
  readonly status: AokanaResourceDecodeStatus;
  readonly bytes: Uint8Array | null;
}

/** 0x1400bccd0. BSE and SDC are deliberately raw here: the shipped VM invokes their native paths. */
export async function decodeAokanaResource(
  stored: Uint8Array,
  mainProcessing: AokanaDistributedProcessing,
  offset = 0,
  length = 0,
): Promise<AokanaResourceDecodeResult> {
  offset >>>= 0;
  length >>>= 0;
  let decoded = stored;
  let initializedLength = stored.length;
  let initialized: Uint8Array | null = null;
  try {
    if (signature(stored, 'DSC FORMAT 1.00\0')) {
      requireAokanaResourceRange(stored.length, 20, 4);
      const size = new DataView(stored.buffer, stored.byteOffset, stored.byteLength).getUint32(20, true);
      if (size > 0x4000000) return {status: 6, bytes: null};
      decoded = decodeDsc(stored);
      initializedLength = decoded.length;
      if (decoded.length !== size) return {status: 5, bytes: null};
    } else if (signature(stored, 'CompressedBG___\0')) {
      requireAokanaResourceRange(stored.length, 46, 2);
      const version = new DataView(stored.buffer, stored.byteOffset, stored.byteLength).getUint16(46, true);
      if (version === 2) {
        const processing = new AokanaDistributedProcessing(mainProcessing.allocator, mainProcessing.capacity);
        let faulted = true;
        try {
          const resource = await decodeAokanaCompressedBgV2(stored, processing);
          decoded = resource.bytes;
          initializedLength = resource.initializedLength;
          initialized = resource.initialized;
          faulted = false;
        } finally {
          // An access fault can leave native workers inside the barrier. Preserve that original
          // fault instead of replacing it with the cleanup attempt's secondary failure.
          try {processing.dispose();} catch (error) {if (!faulted) throw error;}
        }
      } else {
        decoded = packedImage(decodeCompressedBgLegacy(stored));
        initializedLength = decoded.length;
      }
    }
  } catch (error) {
    if (error instanceof AokanaResourceCodecException ||
        (error instanceof Error && error.message === 'CompressedBG table checksum mismatch')) return {status: 5, bytes: null};
    if (error instanceof RangeError || (error instanceof Error &&
        /^(Invalid range |Truncated BURIKO bitstream|DSC backreference precedes output)/.test(error.message))) {
      throw new AokanaUndefinedResourceRead(error.message);
    }
    throw error;
  }
  if (offset === 0 && length === 0) length = decoded.length;
  if (length === 0 || decoded.length < length) return {status: 3, bytes: null};
  if (decoded.length < (offset + length) >>> 0) return {status: 2, bytes: null};
  if (offset + length > decoded.length) {
    throw new AokanaUndefinedResourceRead('Aokana resource slice wraps beyond its native allocation');
  }
  if (offset + length > initializedLength) {
    throw new AokanaUndefinedResourceRead('Aokana CompressedBG version2 slice includes unwritten allocation bytes');
  }
  if (initialized !== null && initialized.subarray(offset, offset + length).includes(0)) {
    throw new AokanaUndefinedResourceRead('Aokana CompressedBG version2 slice retains unwritten native pixels');
  }
  return {status: 0, bytes: decoded.slice(offset, offset + length)};
}
