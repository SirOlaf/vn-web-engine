import {checkRange} from '../../core/binary.js';
import {randomByteGenerator, signature, unsignedVarint, view} from './binary.js';
export interface BurikoImageDestination {
  readonly bytes: Uint8Array;
  readonly initialized: Uint8Array;
}
export interface BurikoImage {
  width: number;
  height: number;
  bitDepth: number;
  flags: number;
  header: Uint8Array;
  /** Native packed pixels, including the zero fourth byte of expanded 24-bit images. */
  pixels: Uint8Array;
}
/** 0x1400bef70: minimum frequency, then lowest node index, including internal nodes. */
export function frequencyTree(weights: readonly number[]): {root: number; children: number[][]} {
  const frequencies = [...weights],
    active = weights.map((w) => w !== 0),
    children = weights.map(() => [] as number[]);
  if (!active.some(Boolean)) throw new Error('Empty BURIKO frequency table');
  for (;;) {
    const pair: number[] = [];
    for (let branch = 0; branch < 2; branch++) {
      let best = -1;
      for (let i = 0; i < frequencies.length; i++)
        if (active[i] && (best < 0 || frequencies[i]! < frequencies[best]!)) best = i;
      if (best >= 0) {
        active[best] = false;
        pair.push(best);
      }
    }
    const root = frequencies.length;
    children.push(pair);
    frequencies.push(pair.reduce((n, i) => n + frequencies[i]!, 0));
    active.push(true);
    if (active.filter(Boolean).length === 1) return {root, children};
  }
}
/** Legacy CompressedBG version 1; all 8,159 CBG assets in this installation select this path. */
export function decodeCompressedBgV1(bytes: Uint8Array): BurikoImage {
  return decodeLegacy(bytes, true);
}

/** 0x1400bfa50 accepts every non-v2 legacy version and scalar byte-channel depth. */
export function decodeCompressedBgLegacy(
  bytes: Uint8Array,
  destination?: BurikoImageDestination,
): BurikoImage {
  return decodeLegacy(bytes, false, destination);
}

function decodeLegacy(
  bytes: Uint8Array,
  strictVersionOne: boolean,
  destination?: BurikoImageDestination,
): BurikoImage {
  checkRange(bytes.length, 0, 48);
  if (
    !signature(bytes, 'CompressedBG___\0') ||
    (strictVersionOne && view(bytes).getUint16(46, true) !== 1)
  )
    throw new Error('Not legacy CompressedBG version 1');
  const data = view(bytes),
    width = data.getUint16(16, true),
    height = data.getUint16(18, true),
    depth = data.getUint16(20, true);
  if (strictVersionOne && (!width || !height || ![8, 24, 32].includes(depth)))
    throw new Error('Invalid legacy CompressedBG geometry');
  const channels = depth >>> 3,
    size = width * height * channels,
    intermediateSize = data.getUint32(32, true),
    tableSize = data.getUint32(40, true);
  if (strictVersionOne && (size > 0x10000000 || intermediateSize > 0x10000000))
    throw new Error('CompressedBG exceeds inspector memory limit');
  checkRange(bytes.length, 48, tableSize);
  const table = bytes.slice(48, 48 + tableSize),
    random = randomByteGenerator(data.getUint32(36, true));
  let sum = 0,
    xor = 0;
  for (let i = 0; i < table.length; i++) {
    const value = (table[i]! - random()) & 255;
    table[i] = value;
    sum = (sum + value) & 255;
    xor ^= value;
  }
  if (sum !== bytes[44] || xor !== bytes[45])
    throw new Error('CompressedBG table checksum mismatch');
  // BFA50 publishes the header after checksum, before frequency/entropy work.
  const outputChannels = depth === 24 ? 4 : channels;
  if (destination !== undefined) {
    checkRange(destination.bytes.length, 0, 16 + width * height * outputChannels);
    checkRange(destination.initialized.length, 0, 16 + width * height * outputChannels);
    destination.bytes.set(bytes.subarray(16, 32));
    destination.initialized.fill(1, 0, 16);
  }
  const cursor = {position: 0},
    weights = Array.from({length: 256}, () => unsignedVarint(table, cursor));
  if (strictVersionOne && cursor.position !== table.length)
    throw new Error('Trailing CompressedBG table data');
  const tree = frequencyTree(weights),
    bitBytes = bytes.subarray(48 + tableSize),
    intermediate = new Uint8Array(intermediateSize);
  // Most BURIKO Huffman codes are short. Decode an eight-bit prefix in one
  // lookup, while retaining the tree walk for longer codes and short tails.
  const prefixTable = Array.from({length: 256}, (_, prefix) => {
    let node: number | undefined = tree.root,
      consumed = 0;
    while (consumed < 8 && node !== undefined && node >= 256) {
      node = tree.children[node]![(prefix >>> (7 - consumed)) & 1];
      consumed++;
    }
    return {node, consumed};
  });
  let bitPosition = 0;
  for (let i = 0; i < intermediate.length; i++) {
    let node: number;
    const remaining = bitBytes.length * 8 - bitPosition;
    if (remaining >= 8) {
      const byteIndex = bitPosition >>> 3,
        shift = bitPosition & 7,
        prefix = (((bitBytes[byteIndex]! << 8) | bitBytes[byteIndex + 1]!) >>> (8 - shift)) & 255,
        entry = prefixTable[prefix]!;
      bitPosition += entry.consumed;
      if (entry.node === undefined) throw new Error('Invalid CompressedBG code');
      node = entry.node;
    } else node = tree.root;
    while (node >= 256) {
      if (bitPosition >= bitBytes.length * 8) throw new Error('Truncated BURIKO bitstream');
      const position = bitPosition++,
        bit = (bitBytes[position >>> 3]! >>> (7 - (position & 7))) & 1,
        child = tree.children[node]![bit];
      if (child === undefined) throw new Error('Invalid CompressedBG code');
      node = child;
    }
    intermediate[i] = node;
  }
  const residuals = new Uint8Array(size);
  cursor.position = 0;
  let p = 0,
    literal = true;
  while (cursor.position < intermediate.length) {
    const count = unsignedVarint(intermediate, cursor);
    checkRange(size, p, count);
    if (literal) {
      checkRange(intermediate.length, cursor.position, count);
      residuals.set(intermediate.subarray(cursor.position, cursor.position + count), p);
      cursor.position += count;
    }
    p += count;
    literal = !literal;
  }
  if (p !== size) throw new Error('CompressedBG residual size mismatch');
  const header =
    destination === undefined ? bytes.slice(16, 32) : destination.bytes.subarray(0, 16);
  let pixels: Uint8Array;
  if (destination === undefined) {
    // The scalar predictor matches the native SIMD paths: average available left/up bytes.
    const stride = width * channels;
    if (width !== 0 && height !== 0) {
      // First row: no up-neighbor. Keep the first pixel untouched (zero predictor).
      for (let x = 1; x < width; x++) {
        const i = x * channels;
        for (let c = 0; c < channels; c++)
          residuals[i + c] = residuals[i + c]! + residuals[i + c - channels]!;
      }
      for (let y = 1; y < height; y++) {
        const row = y * stride;
        // First column: no left-neighbor.
        for (let c = 0; c < channels; c++)
          residuals[row + c] = residuals[row + c]! + residuals[row + c - stride]!;
        // Interior pixels have both reconstructed neighbors.
        for (let x = 1; x < width; x++) {
          const i = row + x * channels;
          for (let c = 0; c < channels; c++)
            residuals[i + c] =
              residuals[i + c]! +
              ((residuals[i + c - stride]! + residuals[i + c - channels]!) >>> 1);
        }
      }
    }
    pixels = residuals;
    if (depth === 24) {
      pixels = new Uint8Array(width * height * 4);
      for (let src = 0, dst = 0; src < size; src += 3, dst += 4)
        pixels.set(residuals.subarray(src, src + 3), dst);
      view(header).setUint16(4, 32, true);
      view(header).setUint16(8, 7, true);
    }
  } else {
    // BF350 reads already reconstructed left/up bytes from this very caller destination.
    pixels = destination.bytes.subarray(16, 16 + width * height * outputChannels);
    const stride = width * outputChannels;
    if (width !== 0 && height !== 0) {
      const firstPixel = (pixel: number, residual: number, predictor: 'zero' | 'left' | 'up') => {
        for (let c = 0; c < channels; c++) {
          const i = pixel + c,
            source = residual + c,
            value =
              predictor === 'zero'
                ? 0
                : predictor === 'left'
                  ? pixels[i - outputChannels]!
                  : pixels[i - stride]!;
          pixels[i] = residuals[source]! + value;
        }
        if (outputChannels !== channels) pixels.fill(0, pixel + channels, pixel + outputChannels);
      };
      // First pixel and first row have no up-neighbor.
      firstPixel(0, 0, 'zero');
      for (let x = 1; x < width; x++) {
        const pixel = x * outputChannels;
        for (let c = 0; c < channels; c++)
          pixels[pixel + c] = residuals[x * channels + c]! + pixels[pixel + c - outputChannels]!;
        if (outputChannels !== channels) pixels.fill(0, pixel + channels, pixel + outputChannels);
      }
      destination.initialized.fill(1, 16, 16 + stride);
      for (let y = 1; y < height; y++) {
        const row = y * stride,
          residual = y * width * channels;
        firstPixel(row, residual, 'up');
        for (let x = 1; x < width; x++) {
          const pixel = row + x * outputChannels,
            source = residual + x * channels;
          for (let c = 0; c < channels; c++)
            pixels[pixel + c] =
              residuals[source + c]! +
              ((pixels[pixel + c - stride]! + pixels[pixel + c - outputChannels]!) >>> 1);
          if (outputChannels !== channels) pixels.fill(0, pixel + channels, pixel + outputChannels);
        }
        destination.initialized.fill(1, 16 + row, 16 + row + stride);
      }
    }
    if (depth === 24) {
      view(header).setUint16(4, 32, true);
      view(header).setUint16(8, 7, true);
    }
  }
  return {
    width,
    height,
    bitDepth: view(header).getUint16(4, true),
    flags: view(header).getUint16(8, true),
    header,
    pixels,
  };
}
/** Raw BURIKO image buffers have a 16-byte header followed by packed pixels. */
export function readBurikoImage(bytes: Uint8Array): BurikoImage {
  checkRange(bytes.length, 0, 16);
  const data = view(bytes),
    width = data.getUint16(0, true),
    height = data.getUint16(2, true),
    bitDepth = data.getUint16(4, true),
    flags = data.getUint16(8, true);
  if (
    !width ||
    !height ||
    ![8, 24, 32].includes(bitDepth) ||
    16 + width * height * (bitDepth / 8) !== bytes.length
  )
    throw new Error('Not a packed BURIKO image');
  return {width, height, bitDepth, flags, header: bytes.slice(0, 16), pixels: bytes.subarray(16)};
}
export function packedImage(image: BurikoImage): Uint8Array {
  const bytes = new Uint8Array(16 + image.pixels.length);
  bytes.set(image.header);
  bytes.set(image.pixels, 16);
  return bytes;
}
