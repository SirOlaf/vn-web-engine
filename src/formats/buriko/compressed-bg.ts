import {checkRange} from '../../core/binary.js';
import {Bits, randomByteGenerator, signature, unsignedVarint, view} from './binary.js';
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
    bits = new Bits(bytes.subarray(48 + tableSize)),
    intermediate = new Uint8Array(intermediateSize);
  for (let i = 0; i < intermediate.length; i++) {
    let node = tree.root;
    while (node >= 256) {
      const child = tree.children[node]![bits.read(1)];
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
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        for (let c = 0; c < channels; c++) {
          const i = y * stride + x * channels + c;
          const predictor = y
            ? x
              ? (residuals[i - stride]! + residuals[i - channels]!) >>> 1
              : residuals[i - stride]!
            : x
              ? residuals[i - channels]!
              : 0;
          residuals[i] = residuals[i]! + predictor;
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
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        for (let c = 0; c < channels; c++) {
          const i = y * stride + x * outputChannels + c;
          const predictor = y
            ? x
              ? (pixels[i - stride]! + pixels[i - outputChannels]!) >>> 1
              : pixels[i - stride]!
            : x
              ? pixels[i - outputChannels]!
              : 0;
          pixels[i] = residuals[(y * width + x) * channels + c]! + predictor;
          destination.initialized[16 + i] = 1;
        }
        for (let c = channels; c < outputChannels; c++) {
          const i = y * stride + x * outputChannels + c;
          pixels[i] = 0;
          destination.initialized[16 + i] = 1;
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
