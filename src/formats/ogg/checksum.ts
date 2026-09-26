// Ogg's non-reflected CRC-32, with initial value zero and no final XOR.
const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index++) {
  let crc = index << 24;
  for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc < 0 ? 0x04c11db7 : 0);
  crcTable[index] = crc;
}
const crcTable2 = new Uint32Array(256);
const crcTable3 = new Uint32Array(256);
const crcTable4 = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index++) {
  let crc = crcTable[index]!;
  crc = (crc << 8) ^ crcTable[crc >>> 24]!;
  crcTable2[index] = crc;
  crc = (crc << 8) ^ crcTable[crc >>> 24]!;
  crcTable3[index] = crc;
  crcTable4[index] = (crc << 8) ^ crcTable[crc >>> 24]!;
}

/** Compute a page checksum while treating its stored checksum (bytes 22–25) as zero. */
export function oggPageChecksum(page: Uint8Array): number {
  let crc = 0;
  let index = 0;
  for (; index < Math.min(26, page.length); index++) {
    const byte = index >= 22 && index < 26 ? 0 : page[index]!;
    crc = (crc << 8) ^ crcTable[(crc >>> 24) ^ byte]!;
  }
  // The remaining bytes have no checksum-field hole. Four table lookups fold
  // four successive polynomial updates without constructing a word DataView.
  for (; index + 4 <= page.length; index += 4) {
    crc ^=
      (page[index]! << 24) | (page[index + 1]! << 16) | (page[index + 2]! << 8) | page[index + 3]!;
    crc =
      crcTable4[crc >>> 24]! ^
      crcTable3[(crc >>> 16) & 255]! ^
      crcTable2[(crc >>> 8) & 255]! ^
      crcTable[crc & 255]!;
  }
  for (; index < page.length; index++) crc = (crc << 8) ^ crcTable[(crc >>> 24) ^ page[index]!]!;
  return crc >>> 0;
}
