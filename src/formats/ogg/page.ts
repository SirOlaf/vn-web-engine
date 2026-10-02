import {byteDataView} from '../../core/binary.js';
import {oggPageChecksum} from './checksum.js';

/** Fixed bytes of a page header before its segment table. */
export const OGG_PAGE_HEADER_SIZE = 27;

export const OGG_CONTINUED = 1;
export const OGG_FIRST_PAGE = 2;
export const OGG_LAST_PAGE = 4;

export interface OggPage {
  /** The whole page: header, segment table and body. */
  readonly bytes: Uint8Array;
  readonly offset: number;
  readonly flags: number;
  /** Granule position; -1 when no packet ends on the page. */
  readonly granule: bigint;
  readonly serial: number;
  readonly sequence: number;
  readonly checksum: number;
  /** Segment table: the length of each body segment; 255 continues a packet. */
  readonly lacing: Uint8Array;
  /** Offset of the body within `bytes`. */
  readonly bodyOffset: number;
}

/** Whether a page header with the `OggS` capture pattern and stream version 0 starts at `offset`. */
export function isOggPageStart(bytes: Uint8Array, offset: number): boolean {
  return (
    offset >= 0 &&
    offset + OGG_PAGE_HEADER_SIZE <= bytes.length &&
    bytes[offset] === 0x4f &&
    bytes[offset + 1] === 0x67 &&
    bytes[offset + 2] === 0x67 &&
    bytes[offset + 3] === 0x53 &&
    bytes[offset + 4] === 0
  );
}

/**
 * The page at `offset`, whose start the caller has checked with `isOggPageStart`, or null
 * when its segment table or body extends past the bytes. The checksum is not verified.
 */
export function readOggPage(bytes: Uint8Array, offset: number): OggPage | null {
  const segments = bytes[offset + 26]!,
    bodyOffset = OGG_PAGE_HEADER_SIZE + segments;
  if (offset + bodyOffset > bytes.length) return null;
  const lacing = bytes.subarray(offset + OGG_PAGE_HEADER_SIZE, offset + bodyOffset);
  let size = bodyOffset;
  for (const length of lacing) size += length;
  if (offset + size > bytes.length) return null;
  const page = bytes.subarray(offset, offset + size),
    view = byteDataView(page);
  return {
    bytes: page,
    offset,
    flags: page[5]!,
    granule: view.getBigInt64(6, true),
    serial: view.getUint32(14, true),
    sequence: view.getUint32(18, true),
    checksum: view.getUint32(22, true),
    lacing,
    bodyOffset,
  };
}

export function oggPageChecksumValid(page: OggPage): boolean {
  return oggPageChecksum(page.bytes) === page.checksum;
}

/** Joins the segments of consecutive pages of one logical stream into packets. */
export class OggPacketAssembler {
  private parts: Uint8Array[] = [];
  private size = 0;
  /** Packets completed so far. */
  count = 0;

  /** Bytes of the packet that continues on the next page. */
  get pendingSize(): number {
    return this.size;
  }
  get pending(): boolean {
    return this.parts.length > 0;
  }

  /**
   * Adds a page and returns the packets it completes. `limit(index, size)` may throw to
   * reject a packet while it grows.
   */
  push(page: OggPage, limit?: (index: number, size: number) => void): Uint8Array[] {
    const packets: Uint8Array[] = [];
    let read = page.bodyOffset;
    for (const length of page.lacing) {
      this.parts.push(page.bytes.subarray(read, read + length));
      this.size += length;
      read += length;
      limit?.(this.count, this.size);
      if (length < 255) {
        packets.push(this.take());
        this.count++;
      }
    }
    return packets;
  }

  private take(): Uint8Array {
    const parts = this.parts;
    this.parts = [];
    if (parts.length === 1) {
      this.size = 0;
      return parts[0]!.slice();
    }
    const packet = new Uint8Array(this.size);
    let at = 0;
    for (const part of parts) {
      packet.set(part, at);
      at += part.length;
    }
    this.size = 0;
    return packet;
  }
}
