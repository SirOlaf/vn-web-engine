import {checkRange} from '../../core/binary.js';
import {randomByteGenerator, signature, view} from './binary.js';
/** 0x1400f42d0 / 0x1400f4440. Checksums cover the stored (obfuscated) bytes. */
export function decodeSdc(bytes: Uint8Array): Uint8Array {
  checkRange(bytes.length, 0, 32);
  if (!signature(bytes, 'SDC FORMAT 1.00\0')) throw new Error('Not SDC 1.00');
  const data = view(bytes),
    stored = data.getUint32(20, true),
    size = data.getUint32(24, true);
  checkRange(bytes.length, 32, stored);
  if (size > 0x10000000) throw new Error('SDC exceeds inspector memory limit');
  const input = bytes.slice(32, 32 + stored),
    random = randomByteGenerator(data.getUint32(16, true));
  let sum = 0,
    xor = 0;
  for (let i = 0; i < input.length; i++) {
    const b = input[i]!;
    sum = (sum + b) & 65535;
    xor ^= b;
    input[i] = b - random();
  }
  if (sum !== data.getUint16(28, true) || xor !== data.getUint16(30, true))
    throw new Error('SDC checksum mismatch');
  const output = new Uint8Array(size);
  let p = 0,
    q = 0;
  while (p < input.length) {
    const control = input[p++]!;
    if (control & 128) {
      checkRange(input.length, p, 1);
      const count = ((control >>> 3) & 15) + 2,
        distance = ((control & 7) << 8) + input[p++]! + 2;
      if (distance > q) throw new Error('SDC backreference precedes output');
      checkRange(size, q, count);
      for (let i = 0; i < count; i++, q++) output[q] = output[q - distance]!;
    } else {
      const count = control + 1;
      checkRange(input.length, p, count);
      checkRange(size, q, count);
      output.set(input.subarray(p, p + count), q);
      p += count;
      q += count;
    }
  }
  if (q !== size) throw new Error('SDC decoded size mismatch');
  return output;
}
