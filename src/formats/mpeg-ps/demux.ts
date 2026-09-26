import {checkRange} from '../../core/binary.js';
import type {ByteSource} from '../../core/source.js';

export interface MpegPesPacket {
  readonly streamId: number;
  readonly payload: Uint8Array;
  /** Raw 33-bit clock values, at 90 kHz; callers handle wrap and presentation. */
  readonly pts: number | null;
  readonly dts: number | null;
  readonly offset: number;
  readonly nextOffset: number;
}

function timestamp(bytes: Uint8Array, offset: number, prefix: number): number {
  checkRange(bytes.length, offset, 5);
  if (
    bytes[offset]! >>> 4 !== prefix ||
    !(bytes[offset]! & 1) ||
    !(bytes[offset + 2]! & 1) ||
    !(bytes[offset + 4]! & 1)
  )
    throw new Error('Invalid MPEG timestamp marker');
  return (
    ((bytes[offset]! >>> 1) & 7) * 2 ** 30 +
    bytes[offset + 1]! * 2 ** 22 +
    (bytes[offset + 2]! >>> 1) * 2 ** 15 +
    bytes[offset + 3]! * 128 +
    (bytes[offset + 4]! >>> 1)
  );
}

/** MPEG-1 program-stream packets over bounded cached source ranges. Elementary
 * streams and timestamps remain separate; one PES packet need not be one frame. */
export class MpegPsReader {
  position = 0;
  private cache: Uint8Array = new Uint8Array();
  private cacheOffset = 0;
  private ended = false;
  private sawPack = false;
  constructor(
    readonly source: ByteSource,
    private readonly signal?: AbortSignal,
  ) {}

  private async read(offset: number, length: number): Promise<Uint8Array> {
    checkRange(this.source.size, offset, length);
    this.signal?.throwIfAborted();
    if (offset < this.cacheOffset || offset + length > this.cacheOffset + this.cache.length) {
      this.cacheOffset = offset;
      const size = Math.min(this.source.size - offset, Math.max(65536, length));
      this.cache = await this.source.read(offset, size, this.signal);
      if (this.cache.length !== size) throw new Error('Truncated MPEG source read');
    }
    return this.cache.subarray(offset - this.cacheOffset, offset - this.cacheOffset + length);
  }

  async next(): Promise<MpegPesPacket | null> {
    if (this.ended) return null;
    while (this.position < this.source.size) {
      const offset = this.position,
        prefix = await this.read(offset, 4);
      if (prefix[0] || prefix[1] || prefix[2] !== 1)
        throw new Error('Invalid MPEG system start code');
      const streamId = prefix[3]!;
      if (streamId === 0xb9) {
        this.position += 4;
        if (this.position !== this.source.size) throw new Error('Data follows MPEG program end');
        this.ended = true;
        return null;
      }
      if (streamId === 0xba) {
        const pack = await this.read(offset, 12);
        if (pack[4]! >>> 4 !== 2)
          throw new Error('Unsupported MPEG pack version (expected MPEG-1)');
        timestamp(pack, 4, 2);
        if (!(pack[9]! & 0x80) || !(pack[11]! & 1)) throw new Error('Invalid MPEG pack marker');
        this.position += 12;
        this.sawPack = true;
        continue;
      }
      if (!this.sawPack) throw new Error('MPEG packet precedes its pack header');
      if (streamId < 0xbb) throw new Error('Invalid MPEG system packet ID');
      const header = await this.read(offset, 6),
        length = header[4]! * 256 + header[5]!;
      if (!length) throw new Error('Unbounded MPEG PES packet is unsupported');
      const bytes = await this.read(offset + 6, length);
      this.position = offset + 6 + length;
      if (streamId === 0xbb || streamId === 0xbe) continue;
      if (streamId !== 0xbd && (streamId < 0xc0 || streamId > 0xef))
        throw new Error(`Unsupported MPEG program stream 0x${streamId.toString(16)}`);
      let at = 0,
        pts: number | null = null,
        dts: number | null = null;
      // MPEG-1 stuffing and optional STD buffer field.
      while (bytes[at] === 255) {
        if (++at > 16) throw new Error('MPEG PES stuffing exceeds limit');
      }
      checkRange(bytes.length, at, 1);
      if ((bytes[at]! & 0xc0) === 0x40) {
        checkRange(bytes.length, at, 2);
        at += 2;
      }
      checkRange(bytes.length, at, 1);
      const flags = bytes[at]!;
      if (flags >>> 4 === 2) {
        pts = timestamp(bytes, at, 2);
        at += 5;
      } else if (flags >>> 4 === 3) {
        pts = timestamp(bytes, at, 3);
        dts = timestamp(bytes, at + 5, 1);
        at += 10;
      } else if (flags === 15) at++;
      else if ((flags & 0xc0) === 0x80) {
        // Some MPEG-1 video systems use the MPEG-2 PES header form.
        checkRange(bytes.length, at, 3);
        if (flags & 0x30) throw new Error('Scrambled MPEG PES packet');
        const optionalSize = bytes[at + 2]!,
          timestampFlags = bytes[at + 1]! >>> 6;
        checkRange(bytes.length, at + 3, optionalSize);
        if (
          timestampFlags === 1 ||
          (timestampFlags === 2 && optionalSize < 5) ||
          (timestampFlags === 3 && optionalSize < 10)
        )
          throw new Error('Invalid MPEG PES timestamp flags');
        if (timestampFlags >= 2) pts = timestamp(bytes, at + 3, timestampFlags);
        if (timestampFlags === 3) dts = timestamp(bytes, at + 8, 1);
        at += 3 + optionalSize;
      } else throw new Error('Invalid MPEG PES header');
      checkRange(bytes.length, at, 0);
      return {streamId, payload: bytes.subarray(at), pts, dts, offset, nextOffset: this.position};
    }
    if (!this.sawPack) throw new Error('Missing MPEG pack header');
    this.ended = true;
    return null;
  }
}
