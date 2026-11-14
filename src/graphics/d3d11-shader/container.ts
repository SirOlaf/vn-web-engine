import {ByteView} from '../../core/binary.js';

/** A container part; data borrows the caller's immutable byte image. */
export interface DxbcPart {
  readonly kind: string;
  readonly offset: number;
  readonly data: Uint8Array;
}
export interface DxbcContainer {
  readonly major: number;
  readonly minor: number;
  /** Stored digest bytes. Container parsing does not validate shader instructions or this digest. */
  readonly digest: Uint8Array;
  readonly parts: readonly DxbcPart[];
}

/** Bounded DXBC container reader, shared by native D3D11 clients and shader tooling. */
export function parseDxbcContainer(bytes: Uint8Array): DxbcContainer {
  const v = new ByteView(bytes, {littleEndian: true});
  v.check(0, 32);
  if (v.ascii(0, 4) !== 'DXBC') throw new Error('Invalid DXBC signature');
  const major = v.u16(20),
    minor = v.u16(22),
    length = v.u32(24),
    count = v.u32(28);
  if (major !== 1 || minor !== 0) throw new Error('Unsupported DXBC container version');
  if (length !== bytes.length || length > 0x80000000)
    throw new Error('Invalid DXBC container size');
  if (count > 4096) throw new Error('DXBC part count exceeds allocation limit');
  const headerEnd = 32 + count * 4;
  v.check(32, count * 4);
  const parts: DxbcPart[] = [];
  for (let i = 0; i < count; i++) {
    const offset = v.u32(32 + i * 4);
    if (offset < headerEnd) throw new Error('DXBC part overlaps the header');
    v.check(offset, 8);
    const size = v.u32(offset + 4);
    v.check(offset + 8, size);
    parts.push({
      kind: v.ascii(offset, 4),
      offset,
      data: bytes.subarray(offset + 8, offset + 8 + size),
    });
  }
  const ordered = [...parts].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1]!;
    if (previous.offset + 8 + previous.data.length > ordered[i]!.offset)
      throw new Error('Overlapping DXBC parts');
  }
  return {major, minor, digest: bytes.subarray(4, 20), parts};
}
