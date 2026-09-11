import {ascii, BinaryReader, checkRange} from '../../core/binary.js';
export type UtfValue = number | bigint | string | Uint8Array;
export type UtfRow = Record<string, UtfValue>;
export interface UtfTable {
  name: string;
  rows: UtfRow[];
}
/** Game.exe 1401ad400 / 1401a1728: offsets relative to byte 8, column flags 0x10/20/40. */
export function parseUtf(bytes: Uint8Array): UtfTable {
  const r = new BinaryReader(bytes);
  if (ascii(bytes, 0, 4) !== '@UTF') throw new Error('Invalid @UTF magic');
  r.position = 4;
  const end = r.u32() + 8;
  checkRange(bytes.length, 0, end);
  r.position = 8;
  const version = r.u16();
  const rowsOffset = r.u16() + 8;
  if (version !== 0) throw new Error(`Unsupported UTF version ${version}`);
  const stringsOffset = r.u32() + 8,
    dataOffset = r.u32() + 8,
    nameOffset = r.u32();
  const columnCount = r.u16(),
    rowSize = r.u16(),
    rowCount = r.u32();
  if (rowCount > 1_000_000) throw new Error('UTF row count exceeds allocation limit');
  if (!(
    32 <= rowsOffset &&
    rowsOffset <= stringsOffset &&
    stringsOffset <= dataOffset &&
    dataOffset <= end
  ))
    throw new Error('Invalid UTF sections');
  checkRange(stringsOffset, rowsOffset, rowSize * rowCount);
  function string(offset: number): string {
    const p = stringsOffset + offset;
    checkRange(dataOffset, p, 1);
    const nul = bytes.indexOf(0, p);
    if (nul < 0 || nul >= dataOffset) throw new Error('Unterminated UTF string');
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(p, nul));
  }
  function value(type: number): UtfValue {
    switch (type) {
      case 0:
        return r.u8();
      case 1:
        return r.i8();
      case 2:
        return r.u16();
      case 3:
        return r.i16();
      case 4:
        return r.u32();
      case 5:
        return r.i32();
      case 6:
        return r.u64();
      case 7:
        return r.i64();
      case 8:
        return r.f32();
      case 9:
        return r.f64();
      case 10:
        return string(r.u32());
      case 11: {
        const start = dataOffset + r.u32(),
          length = r.u32();
        checkRange(end, start, length);
        return bytes.subarray(start, start + length);
      }
      default:
        throw new Error(`Unsupported UTF type ${type}`);
    }
  }
  const columns = [];
  for (let i = 0; i < columnCount; i++) {
    const flags = r.u8(),
      type = flags & 15;
    if (!(flags & 0x10) || flags & 0x80 || (flags & 0x60) === 0x60 || type > 11)
      throw new Error(`Unsupported UTF flags ${flags}`);
    const name = string(r.u32());
    const constant =
      flags & 0x20 ? value(type) : type === 10 ? '' : type === 11 ? new Uint8Array() : 0;
    columns.push({name, type, flags, constant});
  }
  if (r.position > rowsOffset) throw new Error('UTF columns overlap rows');
  const rows: UtfRow[] = [];
  for (let i = 0; i < rowCount; i++) {
    r.position = rowsOffset + i * rowSize;
    const row: UtfRow = Object.create(null);
    for (const c of columns) {
      if (c.name in row) throw new Error('Duplicate UTF column');
      row[c.name] = c.flags & 0x40 ? value(c.type) : c.constant;
    }
    if (r.position !== rowsOffset + (i + 1) * rowSize) throw new Error('UTF row width mismatch');
    rows.push(row);
  }
  return {name: string(nameOffset), rows};
}
