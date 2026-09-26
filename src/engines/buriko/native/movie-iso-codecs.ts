import {BurikoIsoSampleError, type BurikoIsoDescription} from './movie-iso-samples.js';

interface Box {
  type: string;
  body: number;
  end: number;
}
function requireBytes(bytes: Uint8Array, at: number, count: number, end = bytes.length): void {
  if (
    !Number.isSafeInteger(at) ||
    !Number.isSafeInteger(count) ||
    at < 0 ||
    count < 0 ||
    at + count > end
  )
    throw new BurikoIsoSampleError('ISO codec configuration exceeds its encoded entry');
}
function boxes(bytes: Uint8Array, start: number, end: number): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    result: Box[] = [];
  for (let at = start; at < end;) {
    requireBytes(bytes, at, 8, end);
    const short = view.getUint32(at),
      type = String.fromCharCode(...bytes.subarray(at + 4, at + 8)),
      header = short === 1 ? 16 : 8;
    requireBytes(bytes, at, header, end);
    const size =
      short === 0 ? BigInt(end - at) : short === 1 ? view.getBigUint64(at + 8) : BigInt(short);
    if (size < BigInt(header) || size > BigInt(end - at))
      throw new BurikoIsoSampleError('Invalid ISO codec child-box size');
    const next = at + Number(size),
      body = at + header + (type === 'uuid' ? 16 : 0);
    requireBytes(bytes, body, 0, next);
    result.push({type, body, end: next});
    at = next;
  }
  return result;
}
const hex = (byte: number): string => byte.toString(16).padStart(2, '0');

/** AVCDecoderConfigurationRecord remains in avc format; sample NAL lengths are not rewritten. */
export function burikoIsoAvcConfiguration(entry: BurikoIsoDescription): VideoDecoderConfig {
  if (entry.type !== 'avc1' && entry.type !== 'avc3')
    throw new BurikoIsoSampleError('Sample entry is not AVC');
  const bytes = entry.bytes,
    base = entry.headerSize;
  requireBytes(bytes, base, 78);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const children = boxes(bytes, base + 78, bytes.length),
    config = children.find((box) => box.type === 'avcC');
  if (config === undefined)
    throw new BurikoIsoSampleError('AVC sample entry has no configuration record');
  requireBytes(bytes, config.body, 7, config.end);
  if (bytes[config.body] !== 1) throw new BurikoIsoSampleError('Unknown AVC configuration version');
  const output: VideoDecoderConfig = {
    codec: `${entry.type}.${hex(bytes[config.body + 1]!)}${hex(bytes[config.body + 2]!)}${hex(bytes[config.body + 3]!)}`,
    codedWidth: view.getUint16(base + 24),
    codedHeight: view.getUint16(base + 26),
    description: bytes.slice(config.body, config.end),
  };
  const aspect = children.find((box) => box.type === 'pasp');
  if (aspect !== undefined) {
    requireBytes(bytes, aspect.body, 8, aspect.end);
    const horizontal = view.getUint32(aspect.body),
      vertical = view.getUint32(aspect.body + 4);
    if (horizontal === 0 || vertical === 0)
      throw new BurikoIsoSampleError('AVC sample entry has a zero pixel-aspect dimension');
    const width = BigInt(output.codedWidth!) * BigInt(horizontal),
      height = BigInt(output.codedHeight!) * BigInt(vertical);
    let a = width,
      b = height;
    while (b !== 0n) {
      const remainder = a % b;
      a = b;
      b = remainder;
    }
    if (a !== 0n && width / a <= 0xffffffffn && height / a <= 0xffffffffn) {
      output.displayAspectWidth = Number(width / a);
      output.displayAspectHeight = Number(height / a);
    } else throw new BurikoIsoSampleError('AVC display aspect cannot be represented by WebCodecs');
  }
  return output;
}

interface Descriptor {
  tag: number;
  body: number;
  end: number;
}
function descriptors(bytes: Uint8Array, start: number, end: number): Descriptor[] {
  const result: Descriptor[] = [];
  for (let at = start; at < end;) {
    requireBytes(bytes, at, 2, end);
    const tag = bytes[at++]!;
    let size = 0,
      terminated = false;
    for (let index = 0; index < 4; index++) {
      requireBytes(bytes, at, 1, end);
      const byte = bytes[at++]!;
      size = size * 128 + (byte & 127);
      if ((byte & 128) === 0) {
        terminated = true;
        break;
      }
    }
    if (!terminated) throw new BurikoIsoSampleError('ISO descriptor length exceeds four bytes');
    requireBytes(bytes, at, size, end);
    result.push({tag, body: at, end: at + size});
    at += size;
  }
  return result;
}
export interface BurikoAacDecoderConfiguration {
  readonly codec: string;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly description: Uint8Array;
}
/** Reads the ES/DecoderConfig/DecoderSpecificInfo hierarchy, including every optional ES field. */
export function burikoIsoAacConfiguration(
  entry: BurikoIsoDescription,
): BurikoAacDecoderConfiguration {
  if (entry.type !== 'mp4a') throw new BurikoIsoSampleError('Sample entry is not MPEG-4 audio');
  const bytes = entry.bytes,
    base = entry.headerSize,
    view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  requireBytes(bytes, base, 28);
  const version = view.getUint16(base + 8);
  if (version > 2) throw new BurikoIsoSampleError('Unknown QuickTime sound sample-entry version');
  const length = version === 0 ? 28 : version === 1 ? 44 : 64;
  requireBytes(bytes, base, length);
  const sampleRate = version === 2 ? view.getFloat64(base + 32) : view.getUint32(base + 24) / 65536;
  const numberOfChannels = version === 2 ? view.getUint32(base + 40) : view.getUint16(base + 16);
  const children = boxes(bytes, base + length, bytes.length);
  let esds = children.find((box) => box.type === 'esds');
  if (esds === undefined)
    for (const wave of children.filter((box) => box.type === 'wave')) {
      esds = boxes(bytes, wave.body, wave.end).find((box) => box.type === 'esds');
      if (esds !== undefined) break;
    }
  if (esds === undefined)
    throw new BurikoIsoSampleError('MPEG-4 audio has no elementary-stream descriptors');
  requireBytes(bytes, esds.body, 4, esds.end);
  if (bytes[esds.body] !== 0)
    throw new BurikoIsoSampleError('Unknown elementary-stream descriptor version');
  const stream = descriptors(bytes, esds.body + 4, esds.end).find(
    (descriptor) => descriptor.tag === 3,
  );
  if (stream === undefined) throw new BurikoIsoSampleError('MPEG-4 audio has no ES descriptor');
  requireBytes(bytes, stream.body, 3, stream.end);
  const flags = bytes[stream.body + 2]!;
  let at = stream.body + 3;
  if ((flags & 0x80) !== 0) at += 2;
  if ((flags & 0x40) !== 0) {
    requireBytes(bytes, at, 1, stream.end);
    at += 1 + bytes[at]!;
  }
  if ((flags & 0x20) !== 0) at += 2;
  requireBytes(bytes, at, 0, stream.end);
  const decoder = descriptors(bytes, at, stream.end).find((descriptor) => descriptor.tag === 4);
  if (decoder === undefined)
    throw new BurikoIsoSampleError('MPEG-4 audio has no DecoderConfig descriptor');
  requireBytes(bytes, decoder.body, 13, decoder.end);
  const objectType = bytes[decoder.body]!;
  const specific = descriptors(bytes, decoder.body + 13, decoder.end).find(
    (descriptor) => descriptor.tag === 5,
  );
  if (specific === undefined)
    throw new BurikoIsoSampleError('MPEG-4 audio has no AudioSpecificConfig');
  requireBytes(bytes, specific.body, 1, specific.end);
  let audioObjectType = bytes[specific.body]! >>> 3;
  if (audioObjectType === 31) {
    requireBytes(bytes, specific.body, 2, specific.end);
    audioObjectType = 32 + ((bytes[specific.body]! & 7) << 3) + (bytes[specific.body + 1]! >>> 5);
  }
  return {
    codec: objectType === 0x40 ? `mp4a.40.${audioObjectType}` : `mp4a.${hex(objectType)}`,
    sampleRate,
    numberOfChannels,
    description: bytes.slice(specific.body, specific.end),
  };
}
