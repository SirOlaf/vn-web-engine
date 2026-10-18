/** Synthetic XP3 archives for tests. */
import {deflateSync} from 'node:zlib';

export class MemorySource {
  constructor(bytes) {
    this.bytes = bytes;
    this.size = bytes.length;
  }
  async read(offset, length) {
    return this.bytes.slice(offset, offset + length);
  }
}

export const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const part of parts) out.set(part, (p += part.length) - part.length);
  return out;
};
export const u16 = (v) => Uint8Array.of(v & 0xff, v >>> 8);
export const u32 = (v) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return b;
};
export const u64 = (v) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
  return b;
};
export const utf16 = (s) => {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) b.set(u16(s.charCodeAt(i)), i * 2);
  return b;
};
export const chunk = (tag, body) => concat(new TextEncoder().encode(tag), u64(body.length), body);
const MARK = Uint8Array.of(0x58, 0x50, 0x33, 0x0d, 0x0a, 0x20, 0x0a, 0x1a, 0x8b, 0x67, 0x01);

/** Version-2 archive: cushion at 0x17 chains to a zlib index after the member data. */
export function buildXp3(members, extraChunks = []) {
  const header = 0x28;
  let offset = header;
  const blobs = [],
    files = [];
  for (const m of members) {
    const segments = m.segments.map((plain) => {
      const stored = plain.compress ? new Uint8Array(deflateSync(plain.bytes)) : plain.bytes,
        segment = concat(
          u32(plain.compress ? 1 : 0),
          u64(offset),
          u64(plain.bytes.length),
          u64(stored.length),
        );
      blobs.push(stored);
      offset += stored.length;
      return segment;
    });
    const size = m.segments.reduce((n, s) => n + s.bytes.length, 0);
    files.push(
      chunk(
        'File',
        concat(
          chunk(
            'info',
            concat(u32(m.flags ?? 0), u64(size), u64(size), u16(m.name.length), utf16(m.name)),
          ),
          chunk('segm', concat(...segments)),
          chunk('adlr', u32(m.adler)),
        ),
      ),
    );
  }
  const index = concat(...extraChunks, ...files),
    packed = new Uint8Array(deflateSync(index));
  return concat(
    MARK,
    u64(0x17),
    u32(1),
    Uint8Array.of(0x80),
    u64(0),
    u64(offset),
    ...blobs,
    Uint8Array.of(1),
    u64(packed.length),
    u64(index.length),
    packed,
  );
}
