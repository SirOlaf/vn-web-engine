import {checkRange} from '../../core/binary.js';
import {finishTask, runCooperativeTask, type CooperativeTask} from '../../core/cooperative-task.js';
import {
  borrowedBytes,
  randomByteGenerator,
  signature,
  unsignedVarint,
  view,
  type BurikoBorrowedBytes,
} from './binary.js';
import {beginRuntimeSpan} from '../../platform/runtime-performance.js';
export interface BurikoImageDestination {
  /** Read afresh after every yield. */
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
  return finishTask(decodeLegacy(bytes, true));
}

/** 0x1400bfa50 accepts every non-v2 legacy version and scalar byte-channel depth. */
export function decodeCompressedBgLegacy(
  bytes: Uint8Array,
  destination?: BurikoImageDestination,
  accelerator?: CompressedBgLegacyAccelerator,
): BurikoImage {
  return finishTask(decodeLegacy(bytes, false, destination, accelerator));
}

/** The same legacy worker, with bounded steps and borrowed-storage validation on resumption. */
export function decodeCompressedBgLegacyAsync(
  bytes: Uint8Array | BurikoBorrowedBytes,
  destination?: BurikoImageDestination,
  beforeResume?: () => void,
  accelerator?: CompressedBgLegacyAccelerator,
): Promise<BurikoImage> {
  return runCooperativeTask(decodeLegacy(bytes, false, destination, accelerator), beforeResume);
}

/** Validated legacy stream state after checksum, header publication, and tree construction. */
export interface CompressedBgLegacyPlan {
  /** The source, and its bitstream below, are resolved at each read; read them after every yield. */
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly channels: number;
  /** Residual bytes, width * height * channels. */
  readonly size: number;
  /** Bytes per output pixel: four for expanded 24-bit images. */
  readonly outputChannels: number;
  readonly intermediateSize: number;
  readonly tree: {readonly root: number; readonly children: readonly (readonly number[])[]};
  readonly bitBytes: Uint8Array;
  readonly destination: BurikoImageDestination | undefined;
}

/**
 * An alternative implementation of the entropy, run, and predictor stages. It returns null,
 * before writing any destination pixel, to select the reference stages, which then raise any
 * native error. Otherwise it returns the pixels and the header view selected by
 * `legacyImageHeader` immediately before the predictor, after publishing every row.
 */
export type CompressedBgLegacyAccelerator = (
  plan: CompressedBgLegacyPlan,
) => CooperativeTask<{header: Uint8Array; pixels: Uint8Array} | null>;

/** The header the predictor stage publishes and, for 24-bit images, rewrites. A destination
 * header is resolved again when the image is published. */
export function legacyImageHeader(plan: CompressedBgLegacyPlan): Uint8Array {
  return plan.destination === undefined
    ? plan.bytes.slice(16, 32)
    : plan.destination.bytes.subarray(0, 16);
}

/** Add four byte lanes independently, retaining each native byte store's wraparound. */
function addPixelBytes(first: number, second: number): number {
  const mask = 0x00ff00ff;
  return (
    (((first & mask) + (second & mask)) & mask) |
    (((((first >>> 8) & mask) + ((second >>> 8) & mask)) & mask) << 8)
  );
}

function* decodeLegacy(
  input: Uint8Array | BurikoBorrowedBytes,
  strictVersionOne: boolean,
  destination?: BurikoImageDestination,
  accelerator?: CompressedBgLegacyAccelerator,
): CooperativeTask<BurikoImage> {
  const source = borrowedBytes(input);
  let bytes = source.bytes;
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
    if ((i & 16383) === 16383) yield;
  }
  bytes = source.bytes;
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
  const tree = frequencyTree(weights);
  const plan: CompressedBgLegacyPlan = {
    get bytes() {
      return source.bytes;
    },
    width,
    height,
    depth,
    channels,
    size,
    outputChannels,
    intermediateSize,
    tree,
    get bitBytes() {
      return source.bytes.subarray(48 + tableSize);
    },
    destination,
  };
  const accelerated = accelerator === undefined ? null : yield* accelerator(plan);
  if (accelerated !== null) return legacyImage(plan, accelerated.header, accelerated.pixels);
  return yield* decodeLegacyStages(plan);
}

/** Reference entropy, run, and predictor stages. */
function* decodeLegacyStages(plan: CompressedBgLegacyPlan): CooperativeTask<BurikoImage> {
  const {width, height, depth, channels, size, outputChannels} = plan,
    {intermediateSize, tree, destination} = plan,
    cursor = {position: 0},
    intermediate = new Uint8Array(intermediateSize);
  let finishPhase = beginRuntimeSpan('buriko.decode.cbg.entropy');
  try {
    // Fill each leaf's contiguous prefix range once. A sixteen-bit prefix
    // then emits up to four symbols; long codes retain the scalar tree walk.
    // Node fields: consumed bits (5), first node (9; 511 is an absent child).
    const prefixBits = intermediate.length >= 65536 ? 16 : 12,
      prefixNodes = new Uint16Array(1 << prefixBits),
      prefixLengths = new Uint8Array(1 << prefixBits),
      prefixSymbols = new Uint32Array(1 << prefixBits);
    function fillPrefixes(node: number | undefined, prefix: number, consumed: number): void {
      if (node === undefined || node < 256 || consumed === prefixBits) {
        const remaining = prefixBits - consumed;
        prefixNodes.fill(
          ((node ?? 511) << 5) | consumed,
          prefix << remaining,
          (prefix + 1) << remaining,
        );
        return;
      }
      fillPrefixes(tree.children[node]![0], prefix << 1, consumed + 1);
      fillPrefixes(tree.children[node]![1], (prefix << 1) | 1, consumed + 1);
    }
    fillPrefixes(tree.root, 0, 0);
    for (let prefix = 0; prefix < prefixNodes.length; prefix++) {
      let consumed = 0,
        count = 0,
        symbols = 0;
      while (count < 4) {
        const next = prefixNodes[(prefix << consumed) & (prefixNodes.length - 1)]!,
          node = next >>> 5,
          total = consumed + (next & 31);
        if (node >= 256 || total > prefixBits) break;
        symbols |= node << (count * 8);
        consumed = total;
        count++;
      }
      prefixLengths[prefix] = consumed | (count << 5);
      prefixSymbols[prefix] = symbols;
    }
    const intermediateData = view(intermediate);
    yield;
    let bitPosition = 0;
    for (let i = 0; i < intermediate.length;) {
      const end = Math.min(intermediate.length, i + 16384),
        bitBytes = plan.bitBytes;
      for (; i < end;) {
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
              (prefixNodes.length - 1),
            lengths = prefixLengths[prefix]!,
            count = lengths >>> 5;
          if (count !== 0 && i + 4 <= intermediate.length) {
            bitPosition += lengths & 31;
            // The following iteration replaces unused bytes in this word. This
            // scratch buffer remains private until all entropy decoding succeeds.
            intermediateData.setUint32(i, prefixSymbols[prefix]!, true);
            i += count;
            continue;
          }
          const entry = prefixNodes[prefix]!;
          node = entry >>> 5;
          if (node === 511) throw new Error('Invalid CompressedBG code');
          bitPosition += entry & 31;
        } else node = tree.root;
        while (node >= 256) {
          if (bitPosition >= bitBytes.length * 8) throw new Error('Truncated BURIKO bitstream');
          const position = bitPosition++,
            bit = (bitBytes[position >>> 3]! >>> (7 - (position & 7))) & 1,
            child = tree.children[node]![bit];
          if (child === undefined) throw new Error('Invalid CompressedBG code');
          node = child;
        }
        intermediate[i++] = node;
      }
      yield;
    }
    finishPhase?.({
      sourceBytes: plan.bitBytes.length,
      intermediateBytes: intermediateSize,
      prefixBits,
    });
    finishPhase = beginRuntimeSpan('buriko.decode.cbg.runs');
    const residuals = new Uint8Array(size);
    cursor.position = 0;
    let p = 0,
      literal = true,
      nextRunCheckpoint = 65536;
    while (cursor.position < intermediate.length) {
      const count = unsignedVarint(intermediate, cursor);
      checkRange(size, p, count);
      if (literal) {
        checkRange(intermediate.length, cursor.position, count);
        for (let copied = 0; copied < count;) {
          const end = Math.min(count, copied + 65536);
          residuals.set(
            intermediate.subarray(cursor.position + copied, cursor.position + end),
            p + copied,
          );
          copied = end;
          if (copied < count) yield;
        }
        cursor.position += count;
      }
      p += count;
      literal = !literal;
      if (cursor.position >= nextRunCheckpoint) {
        nextRunCheckpoint = cursor.position + 65536;
        yield;
      }
    }
    if (p !== size) throw new Error('CompressedBG residual size mismatch');
    finishPhase?.({intermediateBytes: intermediateSize, residualBytes: size});
    finishPhase = beginRuntimeSpan('buriko.decode.cbg.predictor');
    const header = legacyImageHeader(plan);
    const owned =
      destination !== undefined
        ? null
        : depth === 24
          ? new Uint8Array(width * height * 4)
          : residuals;
    const output = (): Uint8Array =>
      owned ?? destination!.bytes.subarray(16, 16 + width * height * outputChannels);
    let pixels = output();
    if (width !== 0 && height !== 0) {
      if (depth === 24) {
        // Reconstruct directly into expanded BGR0 pixels. Creating a subarray (or
        // calling fill) per pixel costs much more than the three-byte predictor.
        const stride = width * 4;
        let source = 0;
        for (let y = 0; y < height; y++) {
          const row = y * stride,
            end = row + stride;
          pixels = output();
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
          yield;
        }
      } else if (depth === 32 && (pixels.byteOffset & 3) === 0) {
        // Lanes have independent left/up dependencies. Word access is exact for aligned
        // RGBA, including in-place residuals and masks which overlap earlier pixel rows.
        const input = new Uint32Array(residuals.buffer, residuals.byteOffset, size / 4);
        const outputWords = (): Uint32Array => {
          pixels = output();
          return new Uint32Array(pixels.buffer, pixels.byteOffset, size / 4);
        };
        let words = outputWords();
        for (let y = 0; y < height; y++) {
          const row = y * width,
            end = row + width;
          if (y !== 0) words = outputWords();
          let left = y === 0 ? input[row]! : addPixelBytes(input[row]!, words[row - width]!);
          words[row] = left;
          for (let i = row + 1; i < end;) {
            const limit = Math.min(end, i + 16384);
            if (y === 0) {
              for (; i < limit; i++) {
                left = addPixelBytes(input[i]!, left);
                words[i] = left;
              }
            } else {
              for (; i < limit; i++) {
                const up = words[i - width]!,
                  average = (up & left) + (((up ^ left) & 0xfefefefe) >>> 1);
                left = addPixelBytes(input[i]!, average);
                words[i] = left;
              }
            }
            if (i < end) {
              yield;
              words = outputWords();
              left = words[i - 1]!;
            }
          }
          destination?.initialized.fill(1, 16 + row * 4, 16 + end * 4);
          yield;
        }
      } else {
        // A byte-linear walk keeps each reconstructed left/up dependency in the
        // same order as the native scalar predictor, for every channel depth.
        const stride = width * channels;
        for (let c = 0; c < channels; c++) pixels[c] = residuals[c]!;
        for (let i = channels; i < stride; i++) pixels[i] = residuals[i]! + pixels[i - channels]!;
        destination?.initialized.fill(1, 16, 16 + stride);
        yield;
        for (let y = 1; y < height; y++) {
          const row = y * stride,
            firstPixelEnd = row + channels,
            end = row + stride;
          pixels = output();
          for (let i = row; i < firstPixelEnd; i++) pixels[i] = residuals[i]! + pixels[i - stride]!;
          for (let i = firstPixelEnd; i < end; i++)
            pixels[i] = residuals[i]! + ((pixels[i - stride]! + pixels[i - channels]!) >>> 1);
          destination?.initialized.fill(1, 16 + row, 16 + end);
          yield;
        }
      }
    }
    pixels = output();
    finishPhase?.({width, height, depth, outputBytes: pixels.length});
    finishPhase = undefined;
    return legacyImage(plan, header, pixels);
  } finally {
    finishPhase?.();
  }
}

function legacyImage(
  plan: CompressedBgLegacyPlan,
  selected: Uint8Array,
  pixels: Uint8Array,
): BurikoImage {
  const header = plan.destination === undefined ? selected : plan.destination.bytes.subarray(0, 16);
  if (plan.depth === 24) {
    view(header).setUint16(4, 32, true);
    view(header).setUint16(8, 7, true);
  }
  return {
    width: plan.width,
    height: plan.height,
    bitDepth: view(header).getUint16(4, true),
    flags: view(header).getUint16(8, true),
    header,
    pixels,
  };
}
/** A legacy image decoded from a snapshot of its source, outside the caller's storage. */
export interface CompressedBgLegacyDecoded {
  /** Source bytes 16–32, the header published after checksum validation. */
  readonly sourceHeader: Uint8Array;
  /** The final 16-byte header followed by packed pixels, as `packedImage` returns them. */
  readonly packed: Uint8Array;
}

const PUBLISH_BYTES_PER_STEP = 1024 * 1024;

/**
 * Publishes a snapshot-decoded image in the reference stages' order: the source header, then
 * rows whose pixels precede their initialization, then the 24-bit header rewrite. Destination
 * views are read afresh after every yield. Rows are reconstructed from the snapshot, so host
 * writes to published rows do not feed later rows; callers must keep overlapping pixel and
 * initialization views, which the reference predictor reads back, on the reference path.
 * Without a destination the packed buffer is returned as the image's header and pixel views.
 */
export function publishCompressedBgLegacyAsync(
  decoded: CompressedBgLegacyDecoded,
  destination?: BurikoImageDestination,
  beforeResume?: () => void,
): Promise<BurikoImage> {
  return runCooperativeTask(publishLegacy(decoded, destination), beforeResume);
}

function* publishLegacy(
  {sourceHeader, packed}: CompressedBgLegacyDecoded,
  destination: BurikoImageDestination | undefined,
): CooperativeTask<BurikoImage> {
  const data = view(sourceHeader),
    width = data.getUint16(0, true),
    height = data.getUint16(2, true),
    depth = data.getUint16(4, true),
    stride = width * (depth === 24 ? 4 : depth >>> 3),
    extent = 16 + stride * height;
  checkRange(packed.length, 0, extent);
  let header = packed.subarray(0, 16),
    pixels = packed.subarray(16, extent);
  if (destination !== undefined) {
    checkRange(destination.bytes.length, 0, extent);
    checkRange(destination.initialized.length, 0, extent);
    destination.bytes.set(sourceHeader);
    destination.initialized.fill(1, 0, 16);
    const rowsPerStep = Math.max(1, Math.floor(PUBLISH_BYTES_PER_STEP / stride));
    for (let y = 0; y < height;) {
      const end = Math.min(height, y + rowsPerStep),
        first = 16 + y * stride,
        last = 16 + end * stride;
      destination.bytes.set(packed.subarray(first, last), first);
      destination.initialized.fill(1, first, last);
      y = end;
      yield;
    }
    header = destination.bytes.subarray(0, 16);
    pixels = destination.bytes.subarray(16, extent);
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
/** A header stored immediately before its pixels is returned as one view of that storage. */
export function packedImage(image: BurikoImage): Uint8Array {
  const {header, pixels} = image;
  if (
    header.length === 16 &&
    header.buffer === pixels.buffer &&
    header.byteOffset + 16 === pixels.byteOffset
  )
    return new Uint8Array(header.buffer, header.byteOffset, 16 + pixels.length);
  const bytes = new Uint8Array(16 + image.pixels.length);
  bytes.set(image.header);
  bytes.set(image.pixels, 16);
  return bytes;
}
