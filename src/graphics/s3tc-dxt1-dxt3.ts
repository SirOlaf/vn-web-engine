/**
 * DXT1 (BC1) and DXT3 (BC2) to tightly packed RGBA8, for contexts without
 * `WEBGL_compressed_texture_s3tc`. DXT5 lives in `s3tc.ts` (with a Wasm kernel); these
 * formats are rarer and decode in JavaScript.
 *
 * Colour block (8 bytes): RGB565 `color0`, `color1`, then sixteen 2-bit indices, texels
 * row-major. `color0 > color1` (and always for DXT3): four colours, index 2 =
 * `(2·c0 + c1) / 3`, index 3 = `(c0 + 2·c1) / 3`. DXT1 with `color0 <= color1`: index 2 =
 * `(c0 + c1) / 2`, index 3 = transparent black. DXT3 prefixes each colour block with sixteen
 * explicit 4-bit alphas (8 bytes), widened by replication.
 */

/** Byte length of a DXT1 (8-byte blocks) or DXT3/DXT5 (16-byte blocks) surface. */
export function s3tcByteLength(width: number, height: number, blockBytes: 8 | 16): number {
  return Math.ceil(width / 4) * Math.ceil(height / 4) * blockBytes;
}

function expand565(color: number, out: Uint8Array, offset: number): void {
  const r = color >> 11,
    g = (color >> 5) & 63,
    b = color & 31;
  out[offset] = (r << 3) | (r >> 2);
  out[offset + 1] = (g << 2) | (g >> 4);
  out[offset + 2] = (b << 3) | (b >> 2);
  out[offset + 3] = 255;
}

function decode(blocks: Uint8Array, width: number, height: number, dxt3: boolean): Uint8Array {
  const blockBytes = dxt3 ? 16 : 8;
  if (blocks.length < s3tcByteLength(width, height, blockBytes))
    throw new RangeError(`DXT${dxt3 ? 3 : 1} ${width}x${height} needs more data`);
  const output = new Uint8Array(width * height * 4),
    colors = new Uint8Array(16),
    blocksX = Math.ceil(width / 4),
    blocksY = Math.ceil(height / 4);
  let offset = 0;
  for (let by = 0; by < blocksY; by++)
    for (let bx = 0; bx < blocksX; bx++, offset += blockBytes) {
      const color = dxt3 ? offset + 8 : offset;
      const raw0 = blocks[color]! | (blocks[color + 1]! << 8),
        raw1 = blocks[color + 2]! | (blocks[color + 3]! << 8);
      expand565(raw0, colors, 0);
      expand565(raw1, colors, 4);
      const four = dxt3 || raw0 > raw1;
      for (let c = 0; c < 3; c++) {
        const c0 = colors[c]!,
          c1 = colors[4 + c]!;
        if (four) {
          colors[8 + c] = ((2 * c0 + c1) / 3) | 0;
          colors[12 + c] = ((c0 + 2 * c1) / 3) | 0;
        } else {
          colors[8 + c] = ((c0 + c1) / 2) | 0;
          colors[12 + c] = 0;
        }
      }
      colors[11] = 255;
      colors[15] = four ? 255 : 0;
      const indices =
        (blocks[color + 4]! |
          (blocks[color + 5]! << 8) |
          (blocks[color + 6]! << 16) |
          (blocks[color + 7]! << 24)) >>>
        0;
      for (let texel = 0; texel < 16; texel++) {
        const x = bx * 4 + (texel & 3),
          y = by * 4 + (texel >> 2);
        if (x >= width || y >= height) continue;
        const target = (y * width + x) * 4,
          index = ((indices >>> (2 * texel)) & 3) * 4;
        output[target] = colors[index]!;
        output[target + 1] = colors[index + 1]!;
        output[target + 2] = colors[index + 2]!;
        if (dxt3) {
          const nibble = (blocks[offset + (texel >> 1)]! >> ((texel & 1) * 4)) & 15;
          output[target + 3] = nibble * 17;
        } else output[target + 3] = colors[index + 3]!;
      }
    }
  return output;
}

export function decodeDxt1(blocks: Uint8Array, width: number, height: number): Uint8Array {
  return decode(blocks, width, height, false);
}

export function decodeDxt3(blocks: Uint8Array, width: number, height: number): Uint8Array {
  return decode(blocks, width, height, true);
}
