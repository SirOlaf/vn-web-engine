import {readTimeEvents} from '../../formats/buriko/time-event.js';
import {checkRange} from '../../core/binary.js';
import {signature, view} from '../../formats/buriko/binary.js';
import {decodeBse} from '../../formats/buriko/bse.js';
import {decodeDsc} from '../../formats/buriko/dsc.js';
import {decodeSdc} from '../../formats/buriko/compressed-resource.js';
import {
  decodeCompressedBgV1,
  packedImage,
  readBurikoImage,
  type BurikoImage,
} from '../../formats/buriko/compressed-bg.js';
export interface AssetInspection {
  kind: string;
  extension: string;
  mime?: string;
  wrappers: string[];
  bytes: Uint8Array;
  metadata: Record<string, unknown>;
  image?: BurikoImage;
}
export function inspectAsset(stored: Uint8Array, name: string): AssetInspection {
  let bytes = stored;
  const wrappers: string[] = [];
  if (signature(bytes, 'BSE 1.1\0')) {
    bytes = decodeBse(bytes);
    wrappers.push('BSE 1.1');
  }
  let image: BurikoImage | undefined;
  if (signature(bytes, 'DSC FORMAT 1.00\0')) {
    bytes = decodeDsc(bytes);
    wrappers.push('DSC 1.00');
  } else if (signature(bytes, 'SDC FORMAT 1.00\0')) {
    bytes = decodeSdc(bytes);
    wrappers.push('SDC 1.00');
  } else if (signature(bytes, 'CompressedBG___\0')) {
    image = decodeCompressedBgV1(bytes);
    bytes = packedImage(image);
    wrappers.push('CompressedBG v1');
  }
  const result: AssetInspection = {
    kind: 'Binary asset',
    extension: 'bin',
    wrappers,
    bytes,
    metadata: {decodedBytes: bytes.length},
  };
  if (!image) {
    // Exact geometry/length checks, never filename-based image decoding.
    try {
      image = readBurikoImage(bytes);
    } catch {
      /* A raw resource need not be an image. */
    }
  }
  if (image) {
    result.kind = 'BURIKO packed image';
    result.extension = 'bgi';
    result.image = image;
    result.metadata = {
      width: image.width,
      height: image.height,
      bitDepth: image.bitDepth,
      flags: image.flags,
      header: Array.from(image.header),
    };
    return result;
  }
  if (signature(bytes, 'bw  ', 4)) {
    checkRange(bytes.length, 0, 64);
    const data = view(bytes),
      offset = data.getUint32(0, true),
      size = data.getUint32(8, true);
    if (offset !== 64 || size !== bytes.length - 64 || !signature(bytes, 'OggS', 64))
      throw new Error('Invalid Buriko wave wrapper');
    const pageSegments = bytes[90]!;
    checkRange(bytes.length, 91, pageSegments);
    const packet = 91 + pageSegments;
    if (!signature(bytes, '\x01vorbis', packet))
      throw new Error('Buriko wave does not begin with a Vorbis identification packet');
    checkRange(bytes.length, packet, 30);
    const sampleRate = data.getUint32(16, true),
      channels = data.getUint32(20, true);
    if (bytes[packet + 11] !== channels || data.getUint32(packet + 12, true) !== sampleRate)
      throw new Error('Buriko/Vorbis channel or rate mismatch');
    result.kind = 'Buriko wave / Ogg Vorbis';
    result.extension = 'ogg';
    result.mime = 'audio/ogg';
    result.wrappers.push('Buriko wave');
    result.metadata = {
      sampleRate,
      channels,
      headerWords: Array.from({length: 16}, (_, i) => data.getUint32(i * 4, true)),
    };
    result.bytes = bytes.slice(64);
    return result;
  }
  if (signature(bytes, 'BurikoTimeEvent\0')) {
    result.kind = 'BurikoTimeEvent';
    result.extension = 'bte';
    result.metadata = readTimeEvents(bytes);
    return result;
  }
  if (signature(bytes, 'BurikoCompiledScriptVer1.00\0')) {
    checkRange(bytes.length, 0, 32);
    const extendedHeaderBytes = view(bytes).getUint32(28, true);
    checkRange(bytes.length, 28, extendedHeaderBytes);
    result.kind = 'Buriko compiled script 1.00';
    result.extension = 'bcs';
    result.metadata = {
      extendedHeaderBytes,
      bodyOffset: 28 + extendedHeaderBytes,
      decodedBytes: bytes.length,
    };
    return result;
  }
  if (name.endsWith('._bp')) {
    checkRange(bytes.length, 0, 16);
    const data = view(bytes),
      offset = data.getUint32(0, true),
      size = data.getUint32(4, true);
    checkRange(bytes.length, offset, size);
    if (offset < 16 || offset + size !== bytes.length)
      throw new Error('Invalid BURIKO program module span');
    result.kind = 'BURIKO native VM module';
    result.extension = '_bp';
    result.metadata = {
      payloadOffset: offset,
      payloadBytes: size,
      headerWords: [data.getUint32(8, true), data.getUint32(12, true)],
    };
    return result;
  }
  if (signature(bytes, 'BURIKO GDB 3.00\0')) {
    checkRange(bytes.length, 0, 32);
    const data = view(bytes);
    if (data.getUint32(16, true) !== bytes.length) throw new Error('GDB size mismatch');
    const settingsBytes = data.getUint32(28, true);
    checkRange(bytes.length, 32, settingsBytes + 4);
    const variablesOffset = 36 + settingsBytes,
      variablesBytes = data.getUint32(32 + settingsBytes, true);
    checkRange(bytes.length, variablesOffset, variablesBytes + 4);
    result.kind = 'BURIKO GDB 3.00';
    result.extension = 'gdb';
    result.metadata = {
      windowX: data.getInt32(20, true),
      windowY: data.getInt32(24, true),
      settingsOffset: 32,
      settingsBytes,
      variablesOffset,
      variablesBytes,
      stringCount: data.getUint32(variablesOffset + variablesBytes, true),
    };
    return result;
  }
  if (signature(bytes, 'OTTO') || signature(bytes, '\x00\x01\x00\x00')) {
    checkRange(bytes.length, 0, 12);
    const data = view(bytes),
      count = data.getUint16(4, false);
    checkRange(bytes.length, 12, count * 16);
    const tables = Array.from({length: count}, (_, i) => {
      const p = 12 + i * 16,
        offset = data.getUint32(p + 8, false),
        size = data.getUint32(p + 12, false);
      checkRange(bytes.length, offset, size);
      return {tag: String.fromCharCode(...bytes.subarray(p, p + 4)), offset, size};
    });
    result.kind = 'SFNT font';
    result.extension = bytes[0] === 79 ? 'otf' : 'ttf';
    result.mime = bytes[0] === 79 ? 'font/otf' : 'font/ttf';
    result.metadata = {tables};
    return result;
  }
  if (signature(bytes, 'ftyp', 4)) {
    result.kind = 'ISO BMFF movie';
    result.extension = 'mp4';
    result.mime = 'video/mp4';
    return result;
  }
  return result;
}
/** Inspector presentation of native BGR(A); flag 7 is written by native 24-bit expansion. */
export function imageRgba(
  image: BurikoImage,
  mode: 'color' | 'rgb' | 'alpha' = 'color',
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(image.width * image.height * 4),
    channels = image.bitDepth / 8;
  for (let i = 0, p = 0; i < image.pixels.length; i += channels, p += 4) {
    const alpha = channels === 4 ? image.pixels[i + 3]! : 255;
    if (mode === 'alpha') {
      out[p] = out[p + 1] = out[p + 2] = alpha;
      out[p + 3] = 255;
    } else if (channels === 1) {
      out[p] = out[p + 1] = out[p + 2] = image.pixels[i]!;
      out[p + 3] = 255;
    } else {
      out[p] = image.pixels[i + 2]!;
      out[p + 1] = image.pixels[i + 1]!;
      out[p + 2] = image.pixels[i]!;
      out[p + 3] = mode === 'rgb' || channels === 3 || image.flags === 7 ? 255 : alpha;
    }
  }
  return out;
}
