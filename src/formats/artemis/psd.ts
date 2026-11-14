import {BinaryReader} from '../../core/binary.js';

export interface ArtemisPsdImage {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

/** CPsdLoader's merged RGB/RGBA path (187d00), including its stage-enabled
 * integer white-matte recovery. Named PSD layers use a separate native path.
 * Structural/decode failures are explicit; native uninitialized/out-of-bounds
 * output is not replaced with a successful blank image.
 */
export function decodeArtemisPsd(bytes: Uint8Array): ArtemisPsdImage {
  const reader = new BinaryReader(bytes);
  if (reader.u32() !== 0x38425053) throw new Error('Not an Artemis PSD image');
  // Native skips version/reserved; this implementation only accepts the PSD1 layout.
  if (reader.u16() !== 1) throw new Error('Unsupported Artemis PSD version');
  reader.skip(6);
  const channels = reader.u16(),
    height = reader.u32(),
    width = reader.u32();
  if (channels !== 3 && channels !== 4) throw new Error('Unsupported Artemis PSD channels');
  if (reader.u16() !== 8 || reader.u16() !== 3)
    throw new Error('Unsupported Artemis PSD depth or color mode');
  const count = width * height;
  if (
    !width ||
    !height ||
    width > 0x7fffffff ||
    height > 0x7fffffff ||
    !Number.isSafeInteger(count) ||
    count > Math.floor(0x7fffffff / 4)
  )
    throw new Error('Unsupported Artemis PSD dimensions');
  // Color mode data, image resources, then layer/mask information are skipped.
  for (let section = 0; section < 3; section++) reader.skip(reader.u32());
  const compression = reader.u16();
  if (compression !== 0 && compression !== 1)
    throw new Error('Unsupported Artemis PSD compression');
  const planes = compression === 0 ? reader.range(count * channels) : undefined;
  if (compression === 1) reader.data.check(reader.position, channels * height * 2);
  const lengths = compression === 1 ? new Uint16Array(channels * height) : undefined;
  let rowData: Uint8Array | undefined;
  if (lengths) {
    let total = 0;
    for (let index = 0; index < lengths.length; index++) {
      const length = reader.u16();
      if (length > 0x7fff) throw new Error('Unsupported Artemis PSD signed row length');
      lengths[index] = length;
      total += length;
    }
    rowData = reader.range(total);
  }
  const pixels = new Uint8Array(count * 4);
  if (planes) {
    for (let channel = 0; channel < channels; channel++)
      for (let index = 0; index < count; index++)
        pixels[index * 4 + channel] = planes[channel * count + index]!;
  } else {
    let rowOffset = 0;
    for (let channel = 0; channel < channels; channel++)
      for (let y = 0; y < height; y++) {
        const length = lengths![channel * height + y]!;
        const row = rowData!.subarray(rowOffset, rowOffset + length);
        rowOffset += length;
        let source = 0,
          x = 0;
        while (source < row.length) {
          const header = row[source++]!;
          // Native interprets 0x80 as repeat129, not standard PackBits no-op.
          const repeat = header >= 128,
            length = repeat ? 257 - header : header + 1;
          if (x + length > width) throw new Error('Artemis PSD row exceeds image width');
          if (repeat) {
            if (source >= row.length) throw new Error('Truncated Artemis PSD repeat');
            const value = row[source++]!;
            for (let i = 0; i < length; i++) pixels[(y * width + x++) * 4 + channel] = value;
          } else {
            if (source + length > row.length) throw new Error('Truncated Artemis PSD literal');
            for (let i = 0; i < length; i++)
              pixels[(y * width + x++) * 4 + channel] = row[source++]!;
          }
        }
        if (x !== width) throw new Error('Incomplete Artemis PSD row');
      }
  }
  if (channels === 3) {
    for (let index = 3; index < pixels.length; index += 4) pixels[index] = 255;
  } else {
    let anyAlpha = false;
    for (let index = 0; index < pixels.length; index += 4) {
      const alpha = pixels[index + 3]!;
      if (alpha === 0) continue;
      anyAlpha = true;
      if (alpha === 255) continue;
      // 187d00 divides signed integer (channel-255)*256 toward zero.
      for (let channel = 0; channel < 3; channel++)
        pixels[index + channel] = Math.max(
          0,
          Math.min(255, Math.trunc(((pixels[index + channel]! - 255) * 256) / alpha) + 255),
        );
    }
    // Native treats an entirely zero alpha plane as absent and forces opacity.
    if (!anyAlpha) for (let index = 3; index < pixels.length; index += 4) pixels[index] = 255;
  }
  return {width, height, pixels};
}
