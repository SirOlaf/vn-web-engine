import {checkRange} from '../../core/binary.js';
import {signature, view} from './binary.js';
/** Buriko readscrfile._bp +0x18 PRNG and +0x57 BSE transform (decoded file offsets). */
export function decodeBse(bytes: Uint8Array): Uint8Array {
  checkRange(bytes.length, 0, 80);
  if (!signature(bytes, 'BSE 1.1\0') || view(bytes).getUint16(8, true) !== 0x101)
    throw new Error('Not BSE 1.1 version 0x0101');
  let seed = view(bytes).getInt32(12, true);
  const random = () => {
    const x = (((Math.imul(seed, 127) >> 7) + Math.imul(seed, 83) + 53) | 0) ^ 0xb97a7e5c;
    seed = (x >>> 16) | (x << 16);
    return seed & 0x7fff;
  };
  const output = bytes.slice(16),
    used = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    let index = random() & 63;
    while (used[index]) index = (index + 1) & 63;
    const shift = random() & 7,
      direction = random() & 1;
    const value = (output[index]! - random()) & 255;
    output[index] = direction
      ? (value << shift) | (value >>> (8 - shift))
      : (value >>> shift) | (value << (8 - shift));
    used[index] = 1;
  }
  let sum = 0,
    xor = 0;
  for (const b of output.subarray(0, 64)) {
    sum = (sum + b) & 255;
    xor ^= b;
  }
  if (sum !== bytes[10] || xor !== bytes[11]) throw new Error('BSE checksum mismatch');
  return output;
}
