import {pngCrc} from './decode.js';

function chunk(name: string, data: Uint8Array): Uint8Array {
  const result = new Uint8Array(data.length + 12),
    v = new DataView(result.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) result[4 + i] = name.charCodeAt(i);
  result.set(data, 8);
  v.setUint32(result.length - 4, pngCrc(result.subarray(4, result.length - 4)));
  return result;
}
/** RGBA8 top-down pixels as a PNG (color type 6, filter 0 on every row, zlib deflate). */
export async function encodePng(
  width: number,
  height: number,
  rgba: Uint8Array,
): Promise<Uint8Array> {
  const scanlines = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++)
    scanlines.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const stream = new Blob([scanlines]).stream().pipeThrough(new CompressionStream('deflate'));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  const ihdr = new Uint8Array(13),
    v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const sections = [
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array()),
  ];
  const result = new Uint8Array(sections.reduce((n, part) => n + part.length, 0));
  for (let at = 0, i = 0; i < sections.length; i++) {
    result.set(sections[i]!, at);
    at += sections[i]!.length;
  }
  return result;
}
