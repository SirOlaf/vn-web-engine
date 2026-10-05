import {ByteView} from '../../core/binary.js';
import {md5Hex} from '../../core/md5.js';
import type {Xp3Archive, Xp3Entry} from './xp3.js';

/**
 * Parameters of the CxDec "TinyFilterCore" extraction filter: every byte of a member is XORed
 * with one key byte derived from the member's Adler-32.
 */
export interface CxTinyFilter {
  readonly keyMask: number;
  /** Key used when the derived key byte is zero. */
  readonly zeroKey: number;
}

/**
 * Tiny filters by SHA-256 of the protection plugin that implements them.
 * nekopara_vol1.tpm (internal name cxdec.tpm.dll): TinyFilterCore__Create at 0x10009410,
 * TinyFilterCore__Decrypt at 0x100093b0.
 */
export const CX_TINY_FILTERS: ReadonlyMap<string, CxTinyFilter> = new Map([
  [
    '26903726725a45bab530d153e8f06f0607268783c89b3bf3ad300a960259a792',
    {keyMask: 0x1548e29c, zeroKey: 0xd7},
  ],
]);

export function cxTinyKey(filter: CxTinyFilter, adler: number): number {
  const u = (adler ^ filter.keyMask) >>> 0,
    key = (u ^ (u >>> 8) ^ (u >>> 16) ^ (u >>> 24)) & 0xff;
  return key || filter.zeroKey;
}

/** Decrypts `bytes` in place. The key does not depend on the stream position. */
export function applyCxTinyFilter(filter: CxTinyFilter, adler: number, bytes: Uint8Array): void {
  const key = cxTinyKey(filter, adler);
  for (let i = 0; i < bytes.length; i++) bytes[i]! ^= key;
}

/**
 * Index name of a member: lowercase hex MD5 of the path with ASCII letters lowercased, as
 * UTF-16LE without terminator.
 */
export function cxMemberName(path: string): string {
  const lower = path.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)),
    bytes = new Uint8Array(lower.length * 2),
    view = new DataView(bytes.buffer);
  for (let i = 0; i < lower.length; i++) view.setUint16(i * 2, lower.charCodeAt(i), true);
  return md5Hex(bytes);
}

export interface CxNameRecord {
  /** Adler-32 of the named member. Identical members share a value. */
  readonly adler32: number;
  readonly name: string;
}

/** `eliF` index chunks: the readable member names the plugin lists. */
export function cxNameRecords(archive: Xp3Archive): CxNameRecord[] {
  const records: CxNameRecord[] = [];
  for (const chunk of archive.chunks) {
    if (chunk.tag !== 'eliF') continue;
    const data = new ByteView(chunk.data, {littleEndian: true}),
      length = data.u16(4);
    records.push({
      adler32: data.u32(0),
      name: new TextDecoder('utf-16le').decode(data.range(6, length * 2)),
    });
  }
  return records;
}

/**
 * The view of an XP3 archive that the CxDec storage media (`CxFilterFS`) presents: members are
 * looked up by hashed name and every opened member passes through the tiny filter.
 */
export class CxArchive {
  readonly names: readonly CxNameRecord[];
  constructor(
    readonly archive: Xp3Archive,
    readonly filter: CxTinyFilter,
  ) {
    this.names = cxNameRecords(archive);
  }
  find(path: string): Xp3Entry | undefined {
    return this.archive.find(cxMemberName(path));
  }
  async read(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    const entry = this.find(path);
    if (!entry) throw new Error(`Cx archive member not found: ${path}`);
    return this.readEntry(entry, signal);
  }
  async readEntry(entry: Xp3Entry, signal?: AbortSignal): Promise<Uint8Array> {
    if (entry.adler32 === undefined) throw new Error(`Cx archive member ${entry.name} has no adlr`);
    const bytes = await this.archive.read(entry, signal);
    applyCxTinyFilter(this.filter, entry.adler32, bytes);
    return bytes;
  }
}
