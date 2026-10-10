import {ByteView} from '../../core/binary.js';

/**
 * E-mote PSB body keys by SHA-256 of the motion runtime that holds them. Both runtimes parse
 * the key from a decimal string with `atoi`.
 * emoteplayer.dll: string at 0x100d4394, read at 0x1004bf6d; filter vtable 0x100d7c0c,
 * Decrypt at 0x1004b920; PSB loader at 0x100ae620.
 * emotedriver.dll: string at 0x10071350, read at 0x10001950 and 0x10002c69.
 */
export const EMOTE_PSB_KEYS: ReadonlyMap<string, number> = new Map([
  ['536361228be24fb47de73e7c72409060577e8b926fefa24e1ffd5854e6779541', 742877301],
  ['a3b693b605d67812e489b1fb62cd341012b5514fc9114a032fee4685e70b3a86', 742877301],
]);

/**
 * XORs `bytes` in place with the E-mote keystream for `key`, starting at the stream origin.
 *
 * The keystream is a modified xorshift128 seeded with Marsaglia's first three words and the
 * key. Each state update yields one 32-bit word, consumed low byte first; a new word is drawn
 * when the remaining word is zero, so a word with zero high bytes is cut short.
 */
export function applyPsbKeystream(key: number, bytes: Uint8Array): void {
  let s0 = 123456789,
    s1 = 362436069,
    s2 = 521288629,
    s3 = key >>> 0,
    word = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (word === 0) {
      const t = (s0 ^ (s0 << 11)) >>> 0,
        w = s3;
      s0 = s1;
      s1 = s2;
      s2 = w;
      s3 = (w ^ t ^ ((t ^ (w >>> 11)) >>> 8)) >>> 0;
      word = s3;
    }
    bytes[i]! ^= word & 0xff;
    word >>>= 8;
  }
}

/**
 * Returns a copy of an E-mote PSB with its body filter removed. The filtered range runs from
 * the header offset at 0x08 to the chunk offset table (header offset at 0x18); it covers the
 * name trie, the root tree and the string tables. The header and chunk tables are stored in
 * clear. The filter is symmetric, so the same call also applies it.
 */
export function decryptPsbBody(bytes: Uint8Array, key: number): Uint8Array {
  const view = new ByteView(bytes, {littleEndian: true});
  if (view.ascii(0, 4) !== 'PSB\0') throw new Error('Not a PSB file');
  const start = view.u32(8),
    end = view.u32(24);
  if (start < 0x28 || end < start) throw new Error(`Invalid PSB filter range ${start}-${end}`);
  view.check(start, end - start);
  const out = bytes.slice();
  applyPsbKeystream(key, out.subarray(start, end));
  return out;
}
