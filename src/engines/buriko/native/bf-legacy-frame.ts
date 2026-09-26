import {burikoBfVarint, requireBurikoResourceRange} from './bf-entropy.js';
import {BurikoBitmapStorage, bitmapStorage, type BurikoBitmap} from './bitmap.js';
import {bitmapRead8, bitmapWrite8, bitmapWrite32} from './bitmap-scalar.js';

function read32(bytes: Uint8Array, offset: number): number {
  requireBurikoResourceRange(bytes.length, offset, 4);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

/** 140102010: descending internal nodes, strict minimum selection, reversed children and LSB bits. */
function entropy(frame: Uint8Array): Uint8Array {
  const cursor = {position: 0},
    length = burikoBfVarint(frame, cursor);
  const frequencies = new Uint32Array(511),
    active = new Uint8Array(511);
  const children = Array.from({length: 511}, () => [-1, -1]);
  let total = 0;
  for (let symbol = 0; symbol < 256; symbol++) {
    const frequency = burikoBfVarint(frame, cursor);
    frequencies[symbol] = frequency;
    active[symbol] = Number(frequency !== 0);
    total = (total + frequency) >>> 0;
  }
  let root = 510;
  for (;;) {
    let sum = 0;
    for (let selection = 0; selection < 2; selection++) {
      let best = -1,
        minimum = 0xffffffff;
      for (let index = 0; index < 511; index++) {
        if (active[index] !== 0 && frequencies[index]! < minimum) {
          best = index;
          minimum = frequencies[index]!;
        }
      }
      children[root]![1 - selection] = best;
      if (best !== -1) {
        active[best] = 0;
        sum = (sum + frequencies[best]!) >>> 0;
      }
    }
    frequencies[root] = sum;
    active[root] = Number(sum !== 0);
    if (sum === total) break;
    root--;
    if (root <= 255) break;
  }
  const output = new Uint8Array(length);
  let remaining = 0,
    bits = 0;
  for (let index = 0; index < length; index++) {
    let node = root;
    while (children[node]![0] !== -1 && children[node]![1] !== -1) {
      if (remaining === 0) {
        requireBurikoResourceRange(frame.length, cursor.position, 1);
        bits = frame[cursor.position++]!;
        remaining = 8;
      }
      node = children[node]![bits & 1]!;
      bits >>>= 1;
      remaining--;
    }
    output[index] = node < 256 ? node : 0;
  }
  return output;
}

/** 140101F30: independently sized 80-fill and literal runs; unwritten tail remains undefined. */
function expand(
  frame: Uint8Array,
  keyframe: boolean,
): {storage: BurikoBitmapStorage; length: number} {
  const encoded = entropy(frame),
    length = read32(encoded, 0);
  const storage = new BurikoBitmapStorage(
    new Uint8Array((length + (keyframe ? 0 : 2)) >>> 0),
    false,
  );
  const cursor = {position: 4};
  let output = 0;
  while (cursor.position < encoded.length && output < length) {
    const fill = burikoBfVarint(encoded, cursor),
      literal = burikoBfVarint(encoded, cursor);
    storage.range(output, fill, false);
    storage.bytes.fill(0x80, output, output + fill);
    storage.written(output, fill);
    output = (output + fill) >>> 0;
    requireBurikoResourceRange(encoded.length, cursor.position, literal);
    storage.range(output, literal, false);
    storage.bytes.set(encoded.subarray(cursor.position, cursor.position + literal), output);
    storage.written(output, literal);
    cursor.position = (cursor.position + literal) >>> 0;
    output = (output + literal) >>> 0;
  }
  return {storage, length};
}

function read8(storage: BurikoBitmapStorage, offset: number): number {
  storage.range(offset, 1, true);
  return storage.bytes[offset]!;
}

/** 140101BB0/101560: predictor rows write a contiguous four-byte destination, regardless of stride. */
function keyPixels(
  source: BurikoBitmapStorage,
  width: number,
  height: number,
  depth: number,
  destination: BurikoBitmap,
): void {
  if (depth !== 24 && depth !== 32) return;
  const channels = depth >>> 3,
    sourceStride = (Math.imul(channels, width) + 3) & 0xfffffffc;
  let input = 0,
    output = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let channel = 0; channel < channels; channel++) {
        const at = destination.offset + output + channel;
        let predictor = 0;
        if (x !== 0) predictor = bitmapRead8(destination, at - 4);
        if (y !== 0) {
          const above = bitmapRead8(destination, at - (Math.imul(width, 4) >>> 0));
          predictor = x === 0 ? above : (predictor + above) >>> 1;
        }
        bitmapWrite8(destination, at, read8(source, (input + channel) >>> 0) + predictor);
      }
      if (depth === 24) bitmapWrite8(destination, destination.offset + output + 3, 0);
      input = (input + channels) >>> 0;
      output = (output + 4) >>> 0;
    }
    if (depth === 24) input = (input + sourceStride - Math.imul(channels, width)) >>> 0;
  }
}

/** 140101900/101240: mask-selected blocks reference a complete pre-frame snapshot. */
function deltaPixels(
  source: BurikoBitmapStorage,
  sourceLength: number,
  width: number,
  height: number,
  depth: number,
  destination: BurikoBitmap,
): void {
  const blocksX = ((width + 7) >>> 0) >>> 3,
    blocksY = ((height + 7) >>> 0) >>> 3;
  const maskLength = ((Math.imul(blocksX, blocksY) + 7) >>> 0) >>> 3;
  let changed = 0;
  for (let index = 0; index < maskLength; index++) {
    let byte = read8(source, index);
    while (byte !== 0) {
      changed += byte & 1;
      byte >>>= 1;
    }
  }
  let data = (maskLength + Math.imul(changed, 8)) >>> 0,
    masks = 0,
    blockIndex = 0;
  const extent = (Math.imul(width, height) << 2) >>> 0;
  const previous = bitmapStorage(destination, destination.offset, extent, false).cloneRange(
    destination.offset,
    extent,
  );
  const channels = depth >>> 3,
    horizontalStep = (depth === 24 ? 4 : channels) * 8;
  const stride = Math.imul(width, 4) >>> 0;
  let rowOffset = 0;
  for (let by = 0; by < blocksY; by++) {
    if (data >= sourceLength || rowOffset >= extent) break;
    let blockOffset = rowOffset;
    for (let bx = 0; bx < blocksX; bx++, blockIndex++) {
      if (data >= sourceLength) break;
      if (((read8(source, blockIndex >>> 3) >>> (blockIndex & 7)) & 1) !== 0) {
        const maskStart = maskLength + masks;
        const blockWidth = Math.min(8, width - bx * 8),
          blockHeight = Math.min(8, height - by * 8);
        let consumed = 0;
        if (channels === 3 || channels === 4) {
          for (let y = 0; y < blockHeight; y++) {
            const pixelMask = read8(source, maskStart + y);
            for (let x = 0; x < blockWidth; x++) {
              const local = (Math.imul(y, stride) + x * 4) >>> 0;
              const at = destination.offset + blockOffset + local;
              if (((pixelMask >>> x) & 1) !== 0) {
                for (let channel = 0; channel < channels; channel++)
                  bitmapWrite8(
                    destination,
                    at + channel,
                    read8(previous, blockOffset + local + channel) +
                      read8(source, data + consumed++),
                  );
                if (channels === 3) bitmapWrite8(destination, at + 3, 0);
              } else {
                const dx = (read8(source, data + consumed++) << 24) >> 24;
                if (dx === -128) bitmapWrite32(destination, at, 0);
                else {
                  const dy = (read8(source, data + consumed++) << 24) >> 24;
                  const from = blockOffset + ((Math.imul(dy, stride) + local + dx * 4) >>> 0);
                  previous.range(from, 4, true);
                  bitmapWrite32(destination, at, previous.view.getUint32(from, true));
                }
              }
            }
          }
        }
        data = (data + consumed) >>> 0;
        masks = (masks + 8) >>> 0;
      }
      blockOffset = (blockOffset + horizontalStep) >>> 0;
    }
    rowOffset = (rowOffset + Math.imul(width, 32)) >>> 0;
  }
}

/** Raw 140102370/102260 closure, also usable after a partial-resource frame read. */
export function decodeBurikoLegacyBfFrameData(
  frame: Uint8Array,
  width: number,
  height: number,
  depth: number,
  keyframe: boolean,
  destination: BurikoBitmap,
): boolean {
  const decoded = expand(frame, keyframe);
  if (keyframe) keyPixels(decoded.storage, width >>> 0, height >>> 0, depth >>> 0, destination);
  else
    deltaPixels(
      decoded.storage,
      decoded.length,
      width >>> 0,
      height >>> 0,
      depth >>> 0,
      destination,
    );
  return true;
}

/** 140102470: legacy header-relative table at40; accepted dispatch ignores the lower return value. */
export function decodeBurikoLegacyBfFrame(
  movie: Uint8Array,
  frameIndex: number,
  destination: BurikoBitmap,
): boolean {
  const signature = 'BF_Movie_______\0';
  for (let index = 0; index < signature.length; index++) {
    requireBurikoResourceRange(movie.length, index, 1);
    if (movie[index] !== signature.charCodeAt(index)) return false;
  }
  frameIndex >>>= 0;
  if (frameIndex >= read32(movie, 0x28)) return false;
  const offset = read32(movie, 0x40 + frameIndex * 4);
  if (destination.storage === null) return false;
  if (
    frameIndex !== 0 &&
    (destination.width >>> 0 !== read32(movie, 0x14) ||
      destination.height >>> 0 !== read32(movie, 0x18) ||
      destination.format >>> 0 !== read32(movie, 0x20))
  )
    return false;
  requireBurikoResourceRange(movie.length, offset, 0);
  const decoded = expand(movie.subarray(offset), frameIndex === 0);
  const width = read32(movie, 0x14),
    height = read32(movie, 0x18),
    depth = read32(movie, 0x1c);
  if (frameIndex === 0) keyPixels(decoded.storage, width, height, depth, destination);
  else deltaPixels(decoded.storage, decoded.length, width, height, depth, destination);
  return true;
}
