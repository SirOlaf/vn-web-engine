import {asfGuid, asfGuidAt, readAsfHeader, type AsfHeader} from './header.js';

/** Stream Properties Object of an audio or video stream. */
export type AsfStream =
  | {
      readonly kind: 'video';
      readonly number: number;
      /** BITMAPINFOHEADER compression FourCC (little-endian, e.g. 0x33564d57 for WMV3). */
      readonly codec: number;
      readonly width: number;
      readonly height: number;
      /** Codec data following the BITMAPINFOHEADER. */
      readonly extra: Uint8Array;
      /** Extended Stream Properties average time per frame in 100 ns units, 0 if absent. */
      readonly frameTime: number;
    }
  | {
      readonly kind: 'audio';
      readonly number: number;
      /** WAVEFORMATEX format tag (0x161 WMA, 0x162 WMA Pro, 0x163 WMA Lossless). */
      readonly codec: number;
      readonly channels: number;
      readonly sampleRate: number;
      readonly bytesPerSecond: number;
      readonly blockAlign: number;
      readonly bitsPerSample: number;
      /** WAVEFORMATEX codec data (cbSize bytes). */
      readonly extra: Uint8Array;
    };

export interface AsfLayout extends AsfHeader {
  readonly streams: readonly AsfStream[];
  /** File Properties Object data packet size; ASF files with a Data Object use one size. */
  readonly packetSize: number;
  /** Offset of the first data packet (after the Data Object header). */
  readonly dataOffset: number;
  /** Data Object packet count. */
  readonly packetCount: number;
}

/** A complete media object of one stream. */
export interface AsfMediaObject {
  readonly stream: number;
  /** Presentation time in milliseconds, preroll removed. */
  readonly time: number;
  readonly key: boolean;
  readonly data: Uint8Array;
}

const filePropertiesObject = asfGuid('8CABDCA1-A947-11CF-8EE4-00C00C205365');
const streamPropertiesObject = asfGuid('B7DC0791-A9B7-11CF-8EE6-00C00C205365');
const headerExtensionObject = asfGuid('5FBF03B5-A92E-11CF-8EE3-00C00C205365');
const extendedStreamPropertiesObject = asfGuid('14E6A5CB-C672-4332-8399-A96952065B5A');
const dataObject = asfGuid('75B22636-668E-11CF-A6D9-00AA0062CE6C');
const audioMedia = asfGuid('F8699E40-5B4D-11CF-A8FD-00805F5C442B');
const videoMedia = asfGuid('BC19EFC0-5B4D-11CF-A8FD-00805F5C442B');

/** Header Object streams and packet layout. `bytes` holds at least the Header Object and the
 * 50-byte Data Object header that follows it. */
export function readAsfLayout(bytes: Uint8Array): AsfLayout {
  const header = readAsfHeader(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const streams: AsfStream[] = [];
  const frameTimes = new Map<number, number>();
  let packetSize = 0;
  const streamProperties = (at: number, end: number) => {
    if (at + 78 > end) throw Error('Truncated ASF stream properties object');
    const body = at + 24,
      typeData = view.getUint32(body + 40, true),
      flags = view.getUint16(body + 48, true),
      data = body + 54;
    if (data + typeData > end) throw Error('Invalid ASF stream type data size');
    if (flags & 0x8000) throw Error('Encrypted ASF streams are not supported');
    const number = flags & 0x7f;
    if (asfGuidAt(bytes, body, audioMedia)) {
      if (typeData < 18) throw Error('Truncated ASF WAVEFORMATEX');
      const extraSize = view.getUint16(data + 16, true);
      if (18 + extraSize > typeData) throw Error('Invalid ASF WAVEFORMATEX size');
      streams.push({
        kind: 'audio',
        number,
        codec: view.getUint16(data, true),
        channels: view.getUint16(data + 2, true),
        sampleRate: view.getUint32(data + 4, true),
        bytesPerSecond: view.getUint32(data + 8, true),
        blockAlign: view.getUint16(data + 12, true),
        bitsPerSample: view.getUint16(data + 14, true),
        extra: bytes.slice(data + 18, data + 18 + extraSize),
      });
    } else if (asfGuidAt(bytes, body, videoMedia)) {
      if (typeData < 51) throw Error('Truncated ASF video type data');
      const formatSize = view.getUint16(data + 9, true),
        bitmap = data + 11;
      if (formatSize < 40 || 11 + formatSize > typeData)
        throw Error('Invalid ASF video format size');
      streams.push({
        kind: 'video',
        number,
        codec: view.getUint32(bitmap + 16, true),
        width: view.getInt32(bitmap + 4, true),
        height: Math.abs(view.getInt32(bitmap + 8, true)),
        extra: bytes.slice(bitmap + 40, bitmap + formatSize),
        frameTime: 0,
      });
    }
  };
  const children = (from: number, end: number, count: number | null) => {
    let at = from;
    for (let index = 0; count === null ? at < end : index < count; index++) {
      if (at + 24 > end) throw Error('Truncated ASF header child');
      const size = Number(view.getBigUint64(at + 16, true));
      if (size < 24 || at + size > end) throw Error('Invalid ASF header child size');
      if (asfGuidAt(bytes, at, filePropertiesObject)) {
        const minimum = view.getUint32(at + 24 + 68, true),
          maximum = view.getUint32(at + 24 + 72, true);
        if (minimum !== maximum || minimum === 0) throw Error('Variable ASF packet size');
        packetSize = minimum;
      } else if (asfGuidAt(bytes, at, streamPropertiesObject)) streamProperties(at, at + size);
      else if (asfGuidAt(bytes, at, headerExtensionObject)) {
        if (size < 46) throw Error('Truncated ASF header extension');
        const length = view.getUint32(at + 42, true);
        if (46 + length > size) throw Error('Invalid ASF header extension size');
        children(at + 46, at + 46 + length, null);
      } else if (asfGuidAt(bytes, at, extendedStreamPropertiesObject)) {
        if (size < 88) throw Error('Truncated ASF extended stream properties');
        const body = at + 24,
          number = view.getUint16(body + 48, true),
          names = view.getUint16(body + 60, true),
          systems = view.getUint16(body + 62, true);
        frameTimes.set(number, Number(view.getBigUint64(body + 52, true)));
        let next = body + 64;
        for (let i = 0; i < names; i++) next += 4 + view.getUint16(next + 2, true);
        for (let i = 0; i < systems; i++) next += 22 + view.getUint32(next + 18, true);
        if (next > at + size) throw Error('Invalid ASF extended stream properties size');
        if (next + 24 <= at + size && asfGuidAt(bytes, next, streamPropertiesObject))
          streamProperties(next, at + size);
      }
      at += size;
    }
  };
  children(30, header.headerSize, view.getUint32(24, true));
  if (!packetSize) throw Error('Missing ASF file properties object');
  const data = header.headerSize;
  if (data + 50 > bytes.length) throw Error('Truncated ASF data object header');
  if (!asfGuidAt(bytes, data, dataObject)) throw Error('Missing ASF data object');
  return {
    ...header,
    streams: streams.map((s) =>
      s.kind === 'video' ? {...s, frameTime: frameTimes.get(s.number) ?? 0} : s,
    ),
    packetSize,
    dataOffset: data + 50,
    packetCount: Number(view.getBigUint64(data + 40, true)),
  };
}

/** Reassembles media objects from data packets (fixed size, error correction data,
 * single or multiple payloads, compressed payloads). Objects of a stream are sequential;
 * an object a stream abandons before its last byte is dropped. */
export class AsfDemuxer {
  private readonly pending = new Map<
    number,
    {object: number; time: number; key: boolean; data: Uint8Array; filled: number}
  >();
  constructor(private readonly layout: Pick<AsfLayout, 'packetSize' | 'preroll'>) {}

  packet(packet: Uint8Array): AsfMediaObject[] {
    const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    const out: AsfMediaObject[] = [];
    let at = 0;
    const field = (type: number): number => {
      const value =
        type === 0
          ? 0
          : type === 1
            ? view.getUint8(at)
            : type === 2
              ? view.getUint16(at, true)
              : view.getUint32(at, true);
      at += type === 3 ? 4 : type;
      return value;
    };
    if (packet.length !== this.layout.packetSize) throw Error('Truncated ASF data packet');
    let flags = view.getUint8(at++);
    if (flags & 0x80) {
      if (flags & 0x10) throw Error('Unsupported ASF error correction length type');
      at += flags & 0x0f;
      flags = view.getUint8(at++);
    }
    const properties = view.getUint8(at++);
    const length = field((flags >> 5) & 3) || packet.length;
    field((flags >> 1) & 3); // sequence
    const padding = field((flags >> 3) & 3);
    at += 6; // send time, duration
    const end = Math.min(packet.length, length) - padding;
    const replicatedType = properties & 3,
      offsetType = (properties >> 2) & 3,
      objectType = (properties >> 4) & 3;
    let payloads = 1,
      payloadLengthType = 0;
    if (flags & 1) {
      const p = view.getUint8(at++);
      payloads = p & 0x3f;
      payloadLengthType = p >> 6;
    }
    for (let i = 0; i < payloads; i++) {
      const s = view.getUint8(at++),
        stream = s & 0x7f,
        key = (s & 0x80) !== 0,
        object = field(objectType),
        offset = field(offsetType),
        replicated = field(replicatedType);
      if (at + replicated > end) throw Error('Invalid ASF replicated data length');
      if (replicated === 1) {
        // Compressed payload: `offset` is the presentation time; sub-payloads are
        // complete objects with consecutive object numbers.
        at++; // presentation time delta
        const size = flags & 1 ? field(payloadLengthType) : end - at;
        const stop = at + size;
        if (stop > end) throw Error('Invalid ASF compressed payload length');
        while (at < stop) {
          const n = view.getUint8(at++);
          if (at + n > stop) throw Error('Invalid ASF sub-payload length');
          out.push({
            stream,
            time: offset - Number(this.layout.preroll),
            key,
            data: packet.slice(at, at + n),
          });
          at += n;
        }
        continue;
      }
      if (replicated < 8) throw Error('Invalid ASF replicated data length');
      const objectSize = view.getUint32(at, true),
        time = view.getUint32(at + 4, true);
      at += replicated;
      const size = flags & 1 ? field(payloadLengthType) : end - at;
      if (size < 0 || at + size > end) throw Error('Invalid ASF payload length');
      let current = this.pending.get(stream);
      if (offset === 0 || !current || current.object !== object) {
        current =
          offset === 0
            ? {object, time, key, data: new Uint8Array(objectSize), filled: 0}
            : undefined;
        if (current) this.pending.set(stream, current);
        else this.pending.delete(stream);
      }
      if (current) {
        if (offset !== current.filled || offset + size > current.data.length)
          this.pending.delete(stream);
        else {
          current.data.set(packet.subarray(at, at + size), offset);
          current.filled += size;
          if (current.filled === current.data.length) {
            this.pending.delete(stream);
            out.push({
              stream,
              time: current.time - Number(this.layout.preroll),
              key: current.key,
              data: current.data,
            });
          }
        }
      }
      at += size;
    }
    return out;
  }
}

/** Decoding order for demuxed objects. A muxer may place an object up to the preroll after
 * objects of other streams with the same presentation time (WMA blocks a preroll behind the
 * video). Objects of the held stream wait until an object more than a preroll later has been
 * read; objects of other streams pass at once, so they reach their decoders ahead of the held
 * stream's objects of the same time. */
export class AsfPrerollQueue {
  private readonly queued: AsfMediaObject[] = [];
  private readTime = -Infinity;
  constructor(
    private readonly preroll: number,
    private readonly held: number,
  ) {}

  /** Objects in decoding order once `objects`, the next demuxed objects, have been read. */
  push(objects: readonly AsfMediaObject[]): AsfMediaObject[] {
    const out: AsfMediaObject[] = [];
    for (const object of objects) {
      this.readTime = Math.max(this.readTime, object.time);
      if (object.stream === this.held) this.queued.push(object);
      else out.push(object);
    }
    while (this.queued.length && this.readTime - this.queued[0]!.time > this.preroll)
      out.push(this.queued.shift()!);
    return out;
  }

  /** Releases the held objects at the end of the data. */
  flush(): AsfMediaObject[] {
    return this.queued.splice(0);
  }
}
