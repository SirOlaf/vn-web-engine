import {ascii, BinaryReader, checkRange} from '../../core/binary.js';
/** Game.exe 1401a19d8 + 1401ad650. Reverse MSB-first stream; overlapping reverse copies. */
export function decodeCrilayla(
  input: Uint8Array,
  expectedSize?: number,
  maxSize = 256 * 1024 * 1024,
): Uint8Array {
  if (ascii(input, 0, 8) !== 'CRILAYLA') throw new Error('Invalid CRILAYLA magic');
  const r = new BinaryReader(input, true);
  r.position = 8;
  const bodySize = r.u32(),
    packedSize = r.u32(),
    size = bodySize + 256;
  if (size > maxSize || (expectedSize !== undefined && size !== expectedSize))
    throw new Error(`Invalid CRILAYLA output size ${size}`);
  checkRange(input.length, 16, packedSize + 256);
  const output = new Uint8Array(size);
  output.set(input.subarray(16 + packedSize, 16 + packedSize + 256));
  let cursor = 16 + packedSize - 1,
    bitCount = 0,
    byte = 0,
    dest = size - 1;
  function bits(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++) {
      if (!bitCount) {
        if (cursor < 16) throw new Error('Truncated CRILAYLA bitstream');
        byte = input[cursor--]!;
        bitCount = 8;
      }
      value = value * 2 + ((byte >> --bitCount) & 1);
    }
    return value;
  }
  while (dest >= 256) {
    if (bits(1) === 0) {
      output[dest--] = bits(8);
      continue;
    }
    const distance = bits(13) + 3;
    let length = 3;
    for (const width of [2, 3, 5, 8]) {
      let n = bits(width);
      length += n;
      if (n !== (1 << width) - 1) break;
      if (width === 8) {
        do {
          n = bits(8);
          length += n;
          if (length > dest - 255) throw new Error('CRILAYLA copy exceeds output');
        } while (n === 255);
      }
    }
    if (dest + distance >= size || length > dest - 255)
      throw new Error('Invalid CRILAYLA back-reference');
    for (let i = 0; i < length; i++) {
      output[dest] = output[dest + distance]!;
      dest--;
    }
  }
  return output;
}
