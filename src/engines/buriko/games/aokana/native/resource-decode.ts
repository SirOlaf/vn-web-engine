import {decodeDsc} from '../../../../../formats/buriko/dsc.js';
import {
  decodeCompressedBgLegacy,
  packedImage,
} from '../../../../../formats/buriko/compressed-bg.js';
import {signature} from '../../../../../formats/buriko/binary.js';
import {decodeAokanaCompressedBgV2} from './compressed-bg-v2.js';
import {AokanaUndefinedResourceRead, AokanaResourceCodecException} from './resource-memory.js';
import {requireAokanaResourceRange} from './bf-entropy.js';
import {AokanaDistributedProcessing} from './distributed-processing.js';
import {pointerView, type AokanaBpPointer} from '../bp/memory.js';
export {AokanaUndefinedResourceRead} from './resource-memory.js';

export interface AokanaResourceDestination {
  readonly bytes: Uint8Array;
  /** Omitted only for an existing caller byte view whose contents are already defined. */
  readonly initialized?: Uint8Array;
}
export type AokanaResourceDecodeStatus = 0 | 2 | 3 | 5 | 6;
export interface AokanaResourceDecodeResult {
  readonly status: AokanaResourceDecodeStatus;
  readonly bytes: Uint8Array | null;
  readonly initialized?: Uint8Array;
}

interface AokanaNativeResourceInput {
  readonly format: 'raw' | 'dsc' | 'cbg-legacy' | 'cbg-v2';
  readonly rawLength: number;
}

/** BCCD0's pointer entry: sniff full caller backing, using inputLength only for raw copy size. */
export async function decodeAokanaResourcePointer(
  source: AokanaBpPointer | null,
  inputLength: number,
  mainProcessing: AokanaDistributedProcessing,
  destination: AokanaBpPointer | null,
  actor = mainProcessing.allocator.currentActor,
): Promise<AokanaResourceDecodeResult> {
  const read = (offset: number): number => {
    if (source === null)
      throw new AokanaUndefinedResourceRead('Aokana resource reads a null source');
    return pointerView({bytes: source.bytes, offset: source.offset + offset}, 1).getUint8(0);
  };
  const matches = (magic: string): boolean => {
    for (let index = 0; index < magic.length; index++)
      if (read(index) !== magic.charCodeAt(index)) return false;
    return true;
  };
  let format: AokanaNativeResourceInput['format'];
  if (matches('DSC FORMAT 1.00\0')) format = 'dsc';
  else if (matches('CompressedBG___\0') && read(46) === 2 && read(47) === 0) format = 'cbg-v2';
  else if (matches('CompressedBG___\0')) format = 'cbg-legacy';
  else format = 'raw';
  return decodeAokanaResource(
    source!.bytes.subarray(source!.offset),
    mainProcessing,
    0,
    0,
    destination === null ? null : {bytes: destination.bytes.subarray(destination.offset)},
    {format, rawLength: inputLength >>> 0},
    actor,
  );
}

/** An explicit null destination publishes private native output without reading its retained bytes.
 * Omission keeps the existing strict owned-byte API.
 * 0x1400bccd0. BSE and SDC are deliberately raw here: the shipped VM invokes their native paths. */
export async function decodeAokanaResource(
  stored: Uint8Array,
  mainProcessing: AokanaDistributedProcessing,
  offset = 0,
  length = 0,
  destination?: AokanaResourceDestination | null,
  nativeInput?: AokanaNativeResourceInput,
  actor = mainProcessing.allocator.currentActor,
): Promise<AokanaResourceDecodeResult> {
  offset >>>= 0;
  length >>>= 0;
  const directImage =
    destination !== undefined &&
    offset === 0 &&
    length === 0 &&
    (nativeInput === undefined
      ? signature(stored, 'CompressedBG___\0')
      : nativeInput.format === 'cbg-v2' || nativeInput.format === 'cbg-legacy');
  const target = (extent: number) => {
    requireAokanaResourceRange(destination!.bytes.length, 0, extent);
    if (destination!.initialized !== undefined)
      requireAokanaResourceRange(destination!.initialized.length, 0, extent);
    return {
      bytes: destination!.bytes.subarray(0, extent),
      initialized: destination!.initialized?.subarray(0, extent) ?? new Uint8Array(extent).fill(1),
    };
  };
  let decoded = stored;
  let decodedSize = nativeInput?.rawLength ?? stored.length;
  let initializedLength = stored.length;
  let initialized: Uint8Array | null = null;
  try {
    if (
      nativeInput === undefined
        ? signature(stored, 'DSC FORMAT 1.00\0')
        : nativeInput.format === 'dsc'
    ) {
      requireAokanaResourceRange(stored.length, 20, 4);
      const size = new DataView(stored.buffer, stored.byteOffset, stored.byteLength).getUint32(
        20,
        true,
      );
      if (size > 0x4000000) return {status: 6, bytes: null};
      decoded = decodeDsc(stored);
      decodedSize = decoded.length;
      initializedLength = decoded.length;
      if (decoded.length !== size) return {status: 5, bytes: null};
    } else if (
      nativeInput === undefined
        ? signature(stored, 'CompressedBG___\0')
        : nativeInput.format === 'cbg-v2' || nativeInput.format === 'cbg-legacy'
    ) {
      if (nativeInput === undefined) requireAokanaResourceRange(stored.length, 46, 2);
      let caller: ReturnType<typeof target> | undefined;
      if (directImage && destination !== null) {
        const header = new DataView(stored.buffer, stored.byteOffset, stored.byteLength),
          depth = header.getUint16(20, true);
        const extent =
          16 +
          header.getUint16(16, true) *
            header.getUint16(18, true) *
            (depth === 24 ? 4 : depth >>> 3);
        // The codec validates capacity only after checksum, at its first destination write.
        let callerInitialized = destination!.initialized;
        caller = {
          bytes: destination!.bytes,
          get initialized() {
            return (callerInitialized ??= new Uint8Array(extent).fill(1));
          },
        };
      }
      const version =
        nativeInput === undefined
          ? new DataView(stored.buffer, stored.byteOffset, stored.byteLength).getUint16(46, true)
          : nativeInput.format === 'cbg-v2'
            ? 2
            : 1;
      if (version === 2) {
        const processing = new AokanaDistributedProcessing(
          mainProcessing.allocator,
          mainProcessing.capacity,
        );
        let faulted = true;
        try {
          const resource = await decodeAokanaCompressedBgV2(stored, processing, caller, actor);
          decoded = resource.bytes;
          initializedLength = resource.initializedLength;
          initialized = resource.initialized;
          faulted = false;
        } finally {
          // An access fault can leave native workers inside the barrier. Preserve that original
          // fault instead of replacing it with the cleanup attempt's secondary failure.
          try {
            processing.dispose();
          } catch (error) {
            if (!faulted) throw error;
          }
        }
      } else {
        const image = decodeCompressedBgLegacy(stored, caller);
        decoded =
          caller === undefined
            ? packedImage(image)
            : caller.bytes.subarray(0, 16 + image.pixels.length);
        initialized =
          caller?.initialized.subarray(0, decoded.length) ??
          (directImage ? new Uint8Array(decoded.length).fill(1) : null);
        initializedLength = decoded.length;
      }
      decodedSize = decoded.length;
    }
  } catch (error) {
    if (
      error instanceof AokanaResourceCodecException ||
      (error instanceof Error &&
        (error.message === 'CompressedBG table checksum mismatch' ||
          /^DSC size mismatch: \d+ != \d+$/.test(error.message)))
    )
      return {status: 5, bytes: null};
    if (
      error instanceof RangeError ||
      (error instanceof Error &&
        /^(Invalid range |Truncated BURIKO bitstream|DSC backreference precedes output)/.test(
          error.message,
        ))
    ) {
      throw new AokanaUndefinedResourceRead(error.message);
    }
    throw error;
  }
  if (offset === 0 && length === 0) length = decodedSize;
  if (length === 0 || decodedSize < length) return {status: 3, bytes: null};
  if (decodedSize < (offset + length) >>> 0) return {status: 2, bytes: null};
  if (offset + length > decoded.length) {
    throw new AokanaUndefinedResourceRead(
      'Aokana resource slice wraps beyond its native allocation',
    );
  }
  if (directImage)
    return {status: 0, bytes: decoded.subarray(0, length), initialized: initialized!};
  if (offset + length > initializedLength) {
    throw new AokanaUndefinedResourceRead(
      'Aokana CompressedBG version2 slice includes unwritten allocation bytes',
    );
  }
  if (initialized !== null && initialized.subarray(offset, offset + length).includes(0)) {
    throw new AokanaUndefinedResourceRead(
      'Aokana CompressedBG version2 slice retains unwritten native pixels',
    );
  }
  const bytes = decoded.slice(offset, offset + length);
  if (destination !== undefined && destination !== null) {
    const output = target(length);
    output.bytes.set(bytes);
    output.initialized.fill(1);
    return {status: 0, bytes: output.bytes, initialized: output.initialized};
  }
  return {status: 0, bytes};
}
