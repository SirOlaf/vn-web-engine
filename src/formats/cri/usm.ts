import {BufferedSource} from '../../core/buffered-source.js';
import {ascii, checkRange} from '../../core/binary.js';
import type {ByteSource} from '../../core/source.js';
import {parseUtf} from './utf.js';
export interface UsmPacket {
  tag: string;
  channel: number;
  type: number;
  offset: number;
  nextOffset: number;
  timestamp: number;
  timebase: number;
  payload: Uint8Array;
}
/** CRI USM packets. Native payload/bounds arithmetic: 1401ab43c, 1401ab4e8. */
export class UsmReader {
  private offset = 0;
  private readonly buffered: BufferedSource;
  constructor(
    readonly source: ByteSource,
    startOffset = 0,
  ) {
    checkRange(source.size, startOffset, 0);
    this.offset = startOffset;
    this.buffered = new BufferedSource(source);
  }
  async next(): Promise<UsmPacket | undefined> {
    if (this.offset === this.source.size) return;
    const offset = this.offset,
      h = await this.buffered.read(offset, 32),
      v = new DataView(h.buffer, h.byteOffset, h.byteLength);
    const tag = ascii(h.subarray(0, 4)),
      size = v.getUint32(4),
      body = h[9]!,
      padding = v.getUint16(10);
    if (!offset && tag !== 'CRID') throw new Error('Invalid USM signature');
    if (!['CRID', '@SFV', '@SFA', '@ALP', '@SBT', '@CUE'].includes(tag))
      throw new Error(`Unsupported USM stream ${tag}`);
    if (body < 24 || size < body + padding || size > 16 * 1024 * 1024)
      throw new Error('Invalid USM packet size');
    checkRange(this.source.size, offset, size + 8);
    const type = h[15]! & 3;
    if ((h[15]! & 0xf0) !== 0) throw new Error('Unsupported encrypted USM packet');
    const payload = await this.buffered.read(offset + 8 + body, size - body - padding);
    this.offset += size + 8;
    return {
      tag,
      channel: h[12]!,
      type,
      offset,
      nextOffset: this.offset,
      timestamp: v.getUint32(16),
      timebase: v.getUint32(20),
      payload,
    };
  }
}
export function usmTable(packet: UsmPacket): ReturnType<typeof parseUtf> {
  if (!(packet.type === 1 || packet.type === 3 || packet.tag === 'CRID'))
    throw new Error('USM packet is not metadata');
  return parseUtf(packet.payload);
}
