import {ascii, BinaryReader, checkRange, safeNumber} from '../../core/binary.js';
import type {ByteSource} from '../../core/source.js';
import {parseUtf} from './utf.js';
import type {UtfRow, UtfTable} from './utf.js';
import {decodeCrilayla} from './crilayla.js';
export interface CpkEntry {
  readonly id: number;
  readonly name?: string;
  readonly offset: number;
  readonly storedSize: number;
  readonly size: number;
}
function integer(row: UtfRow, key: string): number {
  const v = row[key];
  const n = typeof v === 'bigint' ? safeNumber(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0)
    throw new Error(`Invalid CPK ${key}`);
  return n;
}
export async function readPacket(
  source: ByteSource,
  offset: number,
  magic: string,
): Promise<UtfTable> {
  const h = await source.read(offset, 16);
  if (ascii(h, 0, 4) !== magic) throw new Error(`Expected ${magic} packet at ${offset}`);
  const r = new BinaryReader(h, true);
  r.position = 8;
  const size = safeNumber(r.u64());
  if (size > 64 * 1024 * 1024) throw new Error('CPK metadata exceeds 64 MiB limit');
  const bytes = (await source.read(offset + 16, size)).slice();
  // Confirmed in Game.exe 1400ed72c and 1400ee878; only the low byte of the evolving key matters.
  if (h[4] === 0) {
    let key = 0x5f;
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = bytes[i]! ^ key;
      key = (key * 0x15) & 255;
    }
  }
  return parseUtf(bytes);
}
export class CpkArchive {
  readonly byId: ReadonlyMap<number, CpkEntry>;
  private constructor(
    readonly source: ByteSource,
    readonly header: UtfRow,
    readonly entries: readonly CpkEntry[],
  ) {
    this.byId = new Map(entries.map((e) => [e.id, e]));
    if (this.byId.size !== entries.length) throw new Error('Duplicate CPK asset ID');
  }
  static async open(source: ByteSource): Promise<CpkArchive> {
    const headers = await readPacket(source, 0, 'CPK ');
    if (headers.rows.length !== 1) throw new Error('Expected one CPK header row');
    const h = headers.rows[0]!,
      content = integer(h, 'ContentOffset'),
      toc = integer(h, 'TocOffset');
    const entries: CpkEntry[] = [];
    if (toc) {
      const table = await readPacket(source, toc, 'TOC '),
        base = Math.min(content, toc);
      for (const row of table.rows) {
        const file = row['FileName'],
          dir = row['DirName'];
        if (typeof file !== 'string' || typeof dir !== 'string')
          throw new Error('Invalid CPK filename');
        entries.push({
          id: integer(row, 'ID'),
          name: dir ? `${dir}/${file}` : file,
          offset: base + integer(row, 'FileOffset'),
          storedSize: integer(row, 'FileSize'),
          size: integer(row, 'ExtractSize'),
        });
      }
    } else {
      const itoc = integer(h, 'ItocOffset');
      if (!itoc || integer(h, 'CpkMode') !== 0) throw new Error('Unsupported CPK index layout');
      const table = await readPacket(source, itoc, 'ITOC');
      if (table.rows.length !== 1) throw new Error('Expected one ITOC row');
      const rows: UtfRow[] = [];
      for (const key of ['DataL', 'DataH']) {
        const data = table.rows[0]![key];
        if (!(data instanceof Uint8Array)) throw new Error(`Invalid ITOC ${key}`);
        if (data.length) rows.push(...parseUtf(data).rows);
      }
      rows.sort((a, b) => integer(a, 'ID') - integer(b, 'ID'));
      const align = integer(h, 'Align');
      if (!align) throw new Error('Invalid CPK alignment');
      let offset = content;
      for (const row of rows) {
        const storedSize = integer(row, 'FileSize');
        entries.push({
          id: integer(row, 'ID'),
          offset,
          storedSize,
          size: integer(row, 'ExtractSize'),
        });
        offset += Math.ceil(storedSize / align) * align;
      }
    }
    if (entries.length !== integer(h, 'Files')) throw new Error('CPK file count mismatch');
    for (const e of entries) checkRange(source.size, e.offset, e.storedSize);
    return new CpkArchive(source, h, entries);
  }
  async read(id: number, maxSize = 256 * 1024 * 1024): Promise<Uint8Array> {
    const e = this.byId.get(id);
    if (!e) throw new Error(`Missing CPK ID ${id}`);
    if (e.size > maxSize || e.storedSize > maxSize)
      throw new Error(`Asset exceeds ${maxSize} byte limit; use readStoredRange for streaming`);
    const bytes = await this.source.read(e.offset, e.storedSize);
    if (bytes.length >= 8 && ascii(bytes, 0, 8) === 'CRILAYLA')
      return decodeCrilayla(bytes, e.size, maxSize);
    if (e.size !== e.storedSize) throw new Error('Unsupported CPK compression');
    return bytes;
  }
  async readStoredRange(id: number, offset: number, length: number): Promise<Uint8Array> {
    const e = this.byId.get(id);
    if (!e) throw new Error(`Missing CPK ID ${id}`);
    checkRange(e.storedSize, offset, length);
    return this.source.read(e.offset + offset, length);
  }
}
