import {isOggPageStart, OggPacketAssembler, readOggPage} from '../ogg/page.js';
import {
  parseTheoraComment,
  parseTheoraInfo,
  parseTheoraSetup,
  theoraHeaderType,
  type TheoraInfo,
  type TheoraSetup,
} from './headers.js';

export interface TheoraStream {
  readonly serial: number;
  readonly info: TheoraInfo;
  readonly setup: TheoraSetup;
  /** Data packets in decode order; an empty packet repeats the previous frame. */
  readonly packets: readonly Uint8Array[];
}

/** Demultiplexes the first Theora logical stream of an Ogg file (the stream whose first
 * packet is a Theora identification header) and parses its three header packets. */
export function readTheoraOgg(bytes: Uint8Array): TheoraStream {
  let serial: number | null = null;
  const rejected = new Set<number>();
  const assembler = new OggPacketAssembler();
  const headers: Uint8Array[] = [],
    packets: Uint8Array[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (!isOggPageStart(bytes, offset)) throw Error('Invalid Ogg page in Theora stream');
    const page = readOggPage(bytes, offset);
    if (!page) throw Error('Truncated Ogg page in Theora stream');
    offset += page.bytes.length;
    if (serial === null) {
      if (rejected.has(page.serial)) continue;
      const first = page.lacing.length ? page.bytes.subarray(page.bodyOffset) : null;
      if (!first || first[0] !== 0x80 || first[1] !== 0x74) {
        rejected.add(page.serial);
        continue;
      }
      serial = page.serial;
    } else if (page.serial !== serial) continue;
    for (const packet of assembler.push(page)) {
      if (headers.length < 3) {
        if (theoraHeaderType(packet) !== 0x80 + headers.length)
          throw Error('Missing Theora header packet');
        headers.push(packet);
      } else packets.push(packet);
    }
  }
  if (serial === null || headers.length < 3) throw Error('No Theora stream');
  const info = parseTheoraInfo(headers[0]!);
  parseTheoraComment(headers[1]!);
  return {serial, info, setup: parseTheoraSetup(headers[2]!), packets};
}
