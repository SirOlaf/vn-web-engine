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
  // Pack the first node and, where both codes fit, a second symbol into one
  // twelve-bit lookup. Scalar tails retain the exact invalid-branch and
  // truncated-bitstream behavior. Entry fields, from the low bit: first code
  // length (4), pair length (4; zero means no pair), first node (9; 511 is an
  // absent child), second symbol (8). A 256-leaf tree has at most 511 nodes.
  const prefixBits = 12,
    prefixTable = new Int32Array(1 << prefixBits);
  for (let prefix = 0; prefix < prefixTable.length; prefix++) {
    let node: number | undefined = tree.root,
      consumed = 0;
    while (consumed < prefixBits && node !== undefined && node >= 256) {
      node = tree.children[node]![(prefix >>> (prefixBits - 1 - consumed)) & 1];
      consumed++;
    }
    let entry = ((node ?? 511) << 8) | consumed;
    if (node !== undefined && node < 256) {
      let second: number | undefined = tree.root,
        total = consumed;
      while (total < prefixBits && second !== undefined && second >= 256) {
        second = tree.children[second]![(prefix >>> (prefixBits - 1 - total)) & 1];
        total++;
      }
      if (second !== undefined && second < 256) entry |= (second << 17) | (total << 4);
    }
    prefixTable[prefix] = entry;
  }
  let bitPosition = 0;
  for (let i = 0; i < intermediate.length; i++) {
    let node: number;
    const remaining = bitBytes.length * 8 - bitPosition;
    if (remaining >= prefixBits) {
      const byteIndex = bitPosition >>> 3,
        shift = bitPosition & 7,
        prefix =
          (((bitBytes[byteIndex]! << 16) |
            (bitBytes[byteIndex + 1]! << 8) |
            bitBytes[byteIndex + 2]!) >>>
            (24 - prefixBits - shift)) &
          (prefixTable.length - 1),
        entry = prefixTable[prefix]!;
      node = (entry >>> 8) & 511;
      if (node === 511) throw new Error('Invalid CompressedBG code');
      const pairConsumed = (entry >>> 4) & 15;
      if (pairConsumed !== 0 && i + 1 < intermediate.length) {
        bitPosition += pairConsumed;
        intermediate[i] = node;
        intermediate[++i] = entry >>> 17;
        continue;
      }
      bitPosition += entry & 15;
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
  const pixels =
    destination !== undefined
      ? destination.bytes.subarray(16, 16 + width * height * outputChannels)
      : depth === 24
        ? new Uint8Array(width * height * 4)
        : residuals;
  if (width !== 0 && height !== 0) {
    if (depth === 24) {
      // Reconstruct directly into expanded BGR0 pixels. Creating a subarray (or
      // calling fill) per pixel costs much more than the three-byte predictor.
      const stride = width * 4;
      let source = 0;
      for (let y = 0; y < height; y++) {
        const row = y * stride,
          end = row + stride;
        if (y === 0) {
          pixels[row] = residuals[source++]!;
          pixels[row + 1] = residuals[source++]!;
          pixels[row + 2] = residuals[source++]!;
        } else {
          pixels[row] = residuals[source++]! + pixels[row - stride]!;
          pixels[row + 1] = residuals[source++]! + pixels[row + 1 - stride]!;
          pixels[row + 2] = residuals[source++]! + pixels[row + 2 - stride]!;
        }
        pixels[row + 3] = 0;
        if (y === 0) {
          for (let pixel = row + 4; pixel < end; pixel += 4) {
            pixels[pixel] = residuals[source++]! + pixels[pixel - 4]!;
            pixels[pixel + 1] = residuals[source++]! + pixels[pixel - 3]!;
            pixels[pixel + 2] = residuals[source++]! + pixels[pixel - 2]!;
            pixels[pixel + 3] = 0;
          }
        } else {
          for (let pixel = row + 4; pixel < end; pixel += 4) {
            pixels[pixel] =
              residuals[source++]! + ((pixels[pixel - stride]! + pixels[pixel - 4]!) >>> 1);
            pixels[pixel + 1] =
              residuals[source++]! + ((pixels[pixel + 1 - stride]! + pixels[pixel - 3]!) >>> 1);
            pixels[pixel + 2] =
              residuals[source++]! + ((pixels[pixel + 2 - stride]! + pixels[pixel - 2]!) >>> 1);
            pixels[pixel + 3] = 0;
          }
        }
        // Native caller destinations publish initialization after each row;
        // this order also matters when the two caller views overlap.
        destination?.initialized.fill(1, 16 + row, 16 + end);
      }
    } else {
      // A byte-linear walk keeps each reconstructed left/up dependency in the
      // same order as the native scalar predictor, for every channel depth.
      const stride = width * channels;
      for (let c = 0; c < channels; c++) pixels[c] = residuals[c]!;
      for (let i = channels; i < stride; i++) pixels[i] = residuals[i]! + pixels[i - channels]!;
      destination?.initialized.fill(1, 16, 16 + stride);
      for (let y = 1; y < height; y++) {
        const row = y * stride,
          firstPixelEnd = row + channels,
          end = row + stride;
        for (let i = row; i < firstPixelEnd; i++) pixels[i] = residuals[i]! + pixels[i - stride]!;
        for (let i = firstPixelEnd; i < end; i++)
          pixels[i] = residuals[i]! + ((pixels[i - stride]! + pixels[i - channels]!) >>> 1);
        destination?.initialized.fill(1, 16 + row, 16 + end);
      }
    }
  }
  if (depth === 24) {
    view(header).setUint16(4, 32, true);
    view(header).setUint16(8, 7, true);
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
