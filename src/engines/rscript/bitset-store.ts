import {byteDataView, checkRange} from '../../core/binary.js';

/**
 * Keyed growable bitsets (std::map<WORD, bytes>, 0x4332F0/0x433370). The system save
 * stores the entry count, then each key, byte length and bytes in ascending key order
 * (0x433230); loading keeps the first occurrence of a duplicated key (0x432FE0).
 */
export class RScriptBitsetStore {
  private readonly sets = new Map<number, Uint8Array>();

  has(key: number, bit: number): boolean {
    const bytes = this.sets.get(key & 0xffff);
    const index = bit >>> 3;
    return !!bytes && index < bytes.length && (bytes[index]! & (1 << (bit & 7))) !== 0;
  }

  add(key: number, bit: number): void {
    key &= 0xffff;
    const index = bit >>> 3;
    let bytes = this.sets.get(key);
    if (!bytes || index >= bytes.length) {
      const grown = new Uint8Array(index + 1);
      if (bytes) grown.set(bytes);
      bytes = grown;
      this.sets.set(key, bytes);
    }
    bytes[index]! |= 1 << (bit & 7);
  }

  clear(): void {
    this.sets.clear();
  }

  encode(): Uint8Array {
    const keys = [...this.sets.keys()].sort((a, b) => a - b);
    const size = 4 + keys.reduce((n, key) => n + 6 + this.sets.get(key)!.length, 0);
    const out = new Uint8Array(size);
    const view = byteDataView(out);
    view.setUint32(0, keys.length, true);
    let cursor = 4;
    for (const key of keys) {
      const bytes = this.sets.get(key)!;
      view.setUint16(cursor, key, true);
      view.setUint32(cursor + 2, bytes.length, true);
      out.set(bytes, cursor + 6);
      cursor += 6 + bytes.length;
    }
    return out;
  }

  /** Replaces the contents; returns the number of bytes consumed. */
  decode(bytes: Uint8Array, offset = 0): number {
    this.sets.clear();
    const view = byteDataView(bytes);
    checkRange(bytes.length, offset, 4);
    const count = view.getUint32(offset, true);
    let cursor = offset + 4;
    for (let i = 0; i < count; i++) {
      checkRange(bytes.length, cursor, 6);
      const key = view.getUint16(cursor, true);
      const length = view.getUint32(cursor + 2, true);
      cursor += 6;
      checkRange(bytes.length, cursor, length);
      if (length && !this.sets.has(key)) this.sets.set(key, bytes.slice(cursor, cursor + length));
      cursor += length;
    }
    return cursor - offset;
  }
}
