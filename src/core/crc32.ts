/** CRC-32 (reflected polynomial 0x04C11DB7, initial and final XOR 0xFFFFFFFF): PNG, zlib
 * and boost `crc_32_type`. */
const crcTable = Uint32Array.from({length: 256}, (_, i) => {
  let c = i;
  for (let n = 0; n < 8; n++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
/** Slicing-by-8: table k maps a byte to its CRC contribution k bytes further on. */
const crcTables = (() => {
  const tables = new Uint32Array(8 * 256);
  tables.set(crcTable);
  for (let k = 1; k < 8; k++)
    for (let i = 0; i < 256; i++) {
      const previous = tables[(k - 1) * 256 + i]!;
      tables[k * 256 + i] = (previous >>> 8) ^ crcTable[previous & 255]!;
    }
  return tables;
})();
export function crc32(bytes: Uint8Array): number {
  const t = crcTables,
    length = bytes.length,
    blocks = length - (length & 7);
  let c = 0xffffffff,
    i = 0;
  for (; i < blocks; i += 8) {
    const low =
      (c ^ (bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24))) >>>
      0;
    c =
      t[1792 + (low & 255)]! ^
      t[1536 + ((low >>> 8) & 255)]! ^
      t[1280 + ((low >>> 16) & 255)]! ^
      t[1024 + (low >>> 24)]! ^
      t[768 + bytes[i + 4]!]! ^
      t[512 + bytes[i + 5]!]! ^
      t[256 + bytes[i + 6]!]! ^
      t[bytes[i + 7]!]!;
  }
  for (; i < length; i++) c = t[(c ^ bytes[i]!) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
