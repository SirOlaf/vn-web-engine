import {byteDataView, checkRange} from '../../core/binary.js';
import type {RScriptImage} from './wcg.js';

interface PsdChannel {
  readonly id: number;
  /** Stored bytes, including the two-byte compression field. */
  readonly length: number;
}

interface PsdLayer {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
  readonly channels: readonly PsdChannel[];
  /** Offset of the first channel's data. */
  readonly data: number;
}

const PSD_SIGNATURE = 0x38425053; // "8BPS"

/** Byte of a native pixel each channel fills: B, G, R and the transparency byte. */
function channelTarget(id: number): number | null {
  if (id === -1) return 3;
  if (id >= 0 && id <= 2) return 2 - id;
  return null;
}

/** sub_437F70: PackBits, where a -128 header repeats 129 times instead of being skipped. */
function unpackRow(bytes: Uint8Array, start: number, end: number, out: Uint8Array): void {
  let input = start,
    output = 0;
  while (input < end && output < out.length) {
    const header = (bytes[input++]! << 24) >> 24;
    if (header >= 0) {
      const count = Math.min(header + 1, out.length - output, end - input);
      out.set(bytes.subarray(input, input + count), output);
      input += header + 1;
      output += count;
    } else {
      const count = Math.min(1 - header, out.length - output);
      out.fill(bytes[input++] ?? 0, output, output + count);
      output += count;
    }
  }
}

/** sub_437BB0: decodes a layer's channels into native pixels (transparency = ~alpha). */
function decodeLayer(bytes: Uint8Array, layer: PsdLayer): Uint8Array {
  const view = byteDataView(bytes);
  const {width, height} = layer;
  const pixels = new Uint8Array(width * height * 4);
  const row = new Uint8Array(width);
  let offset = layer.data;
  for (const channel of layer.channels) {
    const start = offset;
    offset += channel.length;
    const target = channelTarget(channel.id);
    if (target === null || channel.length === 0) continue;
    checkRange(bytes.length, start, channel.length);
    const invert = target === 3 ? 0xff : 0;
    const compression = view.getUint16(start, false);
    let position = start + 2;
    if (compression === 0) {
      checkRange(bytes.length, position, width * height);
      for (let i = 0; i < width * height; i++)
        pixels[i * 4 + target] = bytes[position + i]! ^ invert;
      continue;
    }
    if (compression !== 1) throw new Error(`Unsupported PSD channel compression ${compression}`);
    checkRange(bytes.length, position, height * 2);
    const counts = position;
    position += height * 2;
    for (let y = 0; y < height; y++) {
      const size = view.getUint16(counts + y * 2, false);
      checkRange(bytes.length, position, size);
      row.fill(0);
      unpackRow(bytes, position, position + size, row);
      position += size;
      for (let x = 0, i = y * width * 4 + target; x < width; x++, i += 4)
        pixels[i] = row[x]! ^ invert;
    }
  }
  return pixels;
}

/**
 * Photoshop image as the native `.psd` loader reads it (sub_436EC0, sub_43A570): 8-bit RGB
 * documents only, showing the first layer at its position on a transparent canvas of the
 * document size. Layer opacity, blend modes, further layers and the merged image are
 * ignored, as they are natively.
 */
export function decodePsd(bytes: Uint8Array): RScriptImage {
  const view = byteDataView(bytes);
  if (bytes.length < 26 || view.getUint32(0, false) !== PSD_SIGNATURE)
    throw new Error('Not a PSD image');
  const height = view.getUint32(14, false);
  const width = view.getUint32(18, false);
  const depth = view.getUint16(22, false);
  const mode = view.getUint16(24, false);
  if (view.getUint16(4, false) !== 1 || depth !== 8 || mode !== 3)
    throw new Error(
      `Unsupported PSD (version ${view.getUint16(4, false)}, depth ${depth}, mode ${mode})`,
    );
  if (width < 1 || height < 1 || width * height > 0x4000000)
    throw new Error(`Invalid PSD dimensions ${width}x${height}`);
  let offset = 26;
  const u32 = (): number => {
    checkRange(bytes.length, offset, 4);
    const value = view.getUint32(offset, false);
    offset += 4;
    return value;
  };
  const skip = (length: number): void => {
    checkRange(bytes.length, offset, length);
    offset += length;
  };
  skip(u32()); // colour mode data
  skip(u32()); // image resources
  u32(); // layer and mask information
  u32(); // layer information
  checkRange(bytes.length, offset, 2);
  const count = Math.abs(view.getInt16(offset, false));
  offset += 2;
  if (!count) throw new Error('PSD image has no layers');
  const records: Omit<PsdLayer, 'data'>[] = [];
  for (let i = 0; i < count; i++) {
    checkRange(bytes.length, offset, 18);
    const top = view.getInt32(offset, false),
      left = view.getInt32(offset + 4, false);
    const bottom = view.getInt32(offset + 8, false),
      right = view.getInt32(offset + 12, false);
    const channelCount = view.getUint16(offset + 16, false);
    offset += 18;
    checkRange(bytes.length, offset, channelCount * 6);
    const channels: PsdChannel[] = [];
    for (let c = 0; c < channelCount; c++, offset += 6)
      channels.push({id: view.getInt16(offset, false), length: view.getUint32(offset + 2, false)});
    skip(12); // blend signature and key, opacity, clipping, flags, filler
    const extra = u32();
    skip(extra);
    records.push({top, left, width: right - left, height: bottom - top, channels});
  }
  // Channel data follows the records in layer order.
  const first = records[0]!;
  if (first.width < 0 || first.height < 0 || first.width * first.height > 0x4000000)
    throw new Error(`Invalid PSD layer ${first.width}x${first.height}`);
  const layerPixels = decodeLayer(bytes, {...first, data: offset});

  const pixels = new Uint8Array(width * height * 4);
  new Uint32Array(pixels.buffer).fill(0xff000000);
  const x0 = Math.max(first.left, 0),
    y0 = Math.max(first.top, 0);
  const x1 = Math.min(first.left + first.width, width),
    y1 = Math.min(first.top + first.height, height);
  for (let y = y0; x1 > x0 && y < y1; y++) {
    const source = ((y - first.top) * first.width + (x0 - first.left)) * 4;
    pixels.set(layerPixels.subarray(source, source + (x1 - x0) * 4), (y * width + x0) * 4);
  }
  return {width, height, pixels};
}
