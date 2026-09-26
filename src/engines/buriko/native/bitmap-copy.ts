import {isRasterTextPresentation} from '../../../text/raster-text.js';
import {withBurikoBitmapText} from './bitmap-dom-text.js';
import {
  bitmapStorage,
  cropBurikoBitmap,
  initializedBurikoBitmapView,
  type BurikoBitmap,
  type BurikoBitmapRectangle,
} from './bitmap.js';
import {bitmapRead8, bitmapRead32, bitmapWrite8, bitmapWrite32} from './bitmap-scalar.js';
import {burikoAlphaHalfCoefficient, writeBurikoMappedPairs} from './bitmap-pairs.js';

/** 140041310 ignores unsuccessful rectangle cropping and then clears the original descriptor. */
function clearBurikoBitmapPixels(target: BurikoBitmap): void {
  const rowBytes = Math.imul(target.bytesPerPixel, target.width) >>> 0;
  for (let y = 0; y < target.height >>> 0; y++) {
    if (rowBytes === 0) continue;
    const offset = target.offset + y * target.stride;
    const storage = bitmapStorage(target, offset, rowBytes, false);
    storage.bytes.fill(0, offset, offset + rowBytes);
    storage.written(offset, rowBytes);
  }
}

const clearBurikoBitmapRegion = withBurikoBitmapText(clearBurikoBitmapPixels, {clear: true});

export function clearBurikoBitmap(
  bitmap: BurikoBitmap,
  rectangle: BurikoBitmapRectangle | null = null,
): void {
  const target = {...bitmap};
  if (rectangle !== null) cropBurikoBitmap(target, rectangle);
  clearBurikoBitmapRegion(target);
}

export function copyBlock(
  destination: BurikoBitmap,
  destinationOffset: number,
  source: BurikoBitmap,
  sourceOffset: number,
  length: number,
): void {
  const input = bitmapStorage(source, sourceOffset, length, true).bytes.subarray(
    sourceOffset,
    sourceOffset + length,
  );
  const output = bitmapStorage(destination, destinationOffset, length, false);
  // TypedArray#set snapshots an overlapping source range before writing it.
  output.bytes.set(input, destinationOffset);
  output.written(destinationOffset, length);
}

/** Proven initialized spans may bypass per-block checks; overlapping copies keep native MOVQ order. */
function copyInitializedRows(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  rowBytes: number,
  height: number,
): boolean {
  const input = source.storage,
    output = destination.storage;
  if (input === null || output === null || rowBytes === 0 || height === 0) return false;
  if (
    !(input.bytes.buffer instanceof ArrayBuffer) ||
    !(output.bytes.buffer instanceof ArrayBuffer) ||
    !Number.isSafeInteger(source.offset) ||
    !Number.isSafeInteger(destination.offset) ||
    !Number.isSafeInteger(source.stride) ||
    !Number.isSafeInteger(destination.stride)
  )
    return false;
  const sourceLast = source.offset + (height - 1) * source.stride,
    destinationLast = destination.offset + (height - 1) * destination.stride,
    sourceBegin = Math.min(source.offset, sourceLast),
    destinationBegin = Math.min(destination.offset, destinationLast),
    sourceEnd = Math.max(source.offset, sourceLast) + rowBytes,
    destinationEnd = Math.max(destination.offset, destinationLast) + rowBytes;
  if (
    input.initializedView(sourceBegin, sourceEnd - sourceBegin) === null ||
    output.initializedView(destinationBegin, destinationEnd - destinationBegin) === null
  )
    return false;
  if (input.bytes.buffer === output.bytes.buffer) {
    const sourceBase = input.bytes.byteOffset,
      destinationBase = output.bytes.byteOffset;
    if (
      sourceBase + source.offset === destinationBase + destination.offset &&
      source.stride === destination.stride
    )
      return true;
    if (
      sourceBase + sourceBegin < destinationBase + destinationEnd &&
      destinationBase + destinationBegin < sourceBase + sourceEnd
    )
      return false;
  }
  if (source.stride === rowBytes && destination.stride === rowBytes)
    output.bytes.set(input.bytes.subarray(source.offset, sourceEnd), destination.offset);
  else
    for (let row = 0; row < height; row++) {
      const offset = source.offset + row * source.stride;
      output.bytes.set(
        input.bytes.subarray(offset, offset + rowBytes),
        destination.offset + row * destination.stride,
      );
    }
  return true;
}

/**
 * 1400410c0/14003dd70 copy aligned 16-byte blocks, otherwise successive 8-byte blocks.
 * Only row lengths that are not divisible by four use the native overlap-safe memmove.
 */
function copyBurikoBitmapRowsPixels(destination: BurikoBitmap, source: BurikoBitmap): void {
  const rowBytes = Math.imul(source.bytesPerPixel, source.width) >>> 0;
  const height = source.height >>> 0;
  if (copyInitializedRows(destination, source, rowBytes, height)) return;
  const aligned =
    ((source.offset | destination.offset | source.stride | destination.stride) & 15) === 0;
  const block = (rowBytes & 15) === 0 && aligned ? 16 : 8;
  for (let y = 0; y < height; y++) {
    const input = source.offset + y * source.stride;
    const output = destination.offset + y * destination.stride;
    if (
      (rowBytes & 3) === 0 &&
      rowBytes > block &&
      source.storage !== null &&
      destination.storage !== null &&
      source.storage.bytes.buffer !== destination.storage.bytes.buffer
    ) {
      try {
        copyBlock(destination, output, source, input, rowBytes);
        continue;
      } catch {
        // Re-run the native block order so a later invalid block leaves earlier stores intact.
      }
    }
    if ((rowBytes & 3) !== 0) {
      copyBlock(destination, output, source, input, rowBytes);
      continue;
    }
    let byte = 0;
    for (; byte + block <= rowBytes; byte += block)
      copyBlock(destination, output + byte, source, input + byte, block);
    if (byte < rowBytes) copyBlock(destination, output + byte, source, input + byte, 4);
  }
}

/** Separate bounded spans can convert DWORDs without per-pair tuples or validity checks. */
function copyInitializedRgbToAlpha(destination: BurikoBitmap, source: BurikoBitmap): boolean {
  const width = source.width >>> 0,
    height = source.height >>> 0,
    rowBytes = width * 4,
    output = destination.storage;
  if (
    width === 0 ||
    height === 0 ||
    output === null ||
    !Number.isSafeInteger(destination.offset) ||
    destination.offset < 0 ||
    !Number.isSafeInteger(destination.stride) ||
    destination.stride < rowBytes ||
    source.stride < rowBytes
  )
    return false;
  const input = initializedBurikoBitmapView(source, width, height),
    destinationEnd = destination.offset + (height - 1) * destination.stride + rowBytes;
  if (
    input === null ||
    !(input.buffer instanceof ArrayBuffer) ||
    !(output.bytes.buffer instanceof ArrayBuffer) ||
    input.buffer === output.bytes.buffer ||
    !Number.isSafeInteger(destinationEnd) ||
    destinationEnd > output.bytes.length ||
    // A zero-length initialized span proves liveness without requiring old
    // destination bytes to be initialized. Writes need only the bounds above.
    output.initializedView(0, 0) === null
  )
    return false;
  const view = output.view;
  for (let row = 0; row < height; row++) {
    const inputRow = source.offset + row * source.stride,
      outputRow = destination.offset + row * destination.stride;
    for (let column = 0; column < width; column++) {
      const byte = column * 4;
      view.setUint32(outputRow + byte, input.getUint32(inputRow + byte, true) | 0xff000000, true);
    }
    if (destination.stride !== rowBytes) output.written(outputRow, rowBytes);
  }
  if (destination.stride === rowBytes) output.written(destination.offset, rowBytes * height);
  return true;
}

/** 14003dcc0 preserves source RGB and forces both pair and tail alpha bytes to 255. */
function copyBurikoRgbToAlphaPixels(destination: BurikoBitmap, source: BurikoBitmap): void {
  if (copyInitializedRgbToAlpha(destination, source)) return;
  writeBurikoMappedPairs(destination, source, (pixel) => pixel | 0xff000000);
}

/** 14003dbb0 uses the native alpha/2 table, whose last entry promotes 254 to opaque. */
function copyBurikoAlphaToRgbPixels(destination: BurikoBitmap, source: BurikoBitmap): void {
  writeBurikoMappedPairs(destination, source, (pixel) => {
    const coefficient = burikoAlphaHalfCoefficient(pixel >>> 24);
    let result = 0;
    for (let shift = 0; shift < 24; shift += 8)
      result |= ((Math.imul((pixel >>> shift) & 255, coefficient) & 65535) >>> 7) << shift;
    return result >>> 0;
  });
}

/** 140046620 expands four mask bytes from one source DWORD before storing sixteen bytes. */
function copyBurikoMaskToAlphaPixels(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  color: number,
): void {
  const width = Math.min(destination.width >>> 0, source.width >>> 0);
  const height = Math.min(destination.height >>> 0, source.height >>> 0);
  color &= 0xffffff;
  for (let y = 0; y < height; y++) {
    const input = source.offset + y * source.stride;
    const output = destination.offset + y * destination.stride;
    let x = 0;
    for (; x + 3 < width; x += 4) {
      const mask = bitmapRead32(source, input + x);
      for (let channel = 0; channel < 4; channel++)
        bitmapWrite32(
          destination,
          output + (x + channel) * 4,
          ((mask >>> (channel * 8)) << 24) | color,
        );
    }
    for (; x < width; x++)
      bitmapWrite32(destination, output + x * 4, (bitmapRead8(source, input + x) << 24) | color);
  }
}

/** 14003d270 retains scalar read/store order when source and destination alias. */
function blendBurikoRgbIntoAlphaWithTransparencyPixels(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  transparency: number,
): void {
  const sourceAlpha = Math.imul(256 - transparency, 255) >>> 0;
  const sourceNumerator = (sourceAlpha << 16) >>> 0;
  const destinationFactor = (65536 - sourceAlpha) >>> 0;
  for (let y = 0; y < source.height >>> 0; y++)
    for (let x = 0; x < source.width >>> 0; x++) {
      const input = source.offset + y * source.stride + x * 4;
      const output = destination.offset + y * destination.stride + x * 4;
      const destinationAlpha =
        Math.imul(bitmapRead8(destination, output + 3), destinationFactor) >>> 8;
      const denominator = (sourceAlpha + destinationAlpha) >>> 0;
      if (denominator === 0) {
        if (isRasterTextPresentation()) {
          bitmapWrite32(destination, output, 0);
          continue;
        }
        throw new RangeError('Buriko bitmap native unsigned division by zero');
      }
      const sourceCoefficient = Math.trunc(sourceNumerator / denominator);
      const destinationCoefficient = Math.trunc(((destinationAlpha << 16) >>> 0) / denominator);
      const sourceBlue = Math.imul(bitmapRead8(source, input), sourceCoefficient);
      const destinationBlue = Math.imul(bitmapRead8(destination, output), destinationCoefficient);
      const destinationGreen = Math.imul(
        bitmapRead8(destination, output + 1),
        destinationCoefficient,
      );
      bitmapWrite8(destination, output, (sourceBlue + destinationBlue) >>> 16);
      const sourceGreen = Math.imul(bitmapRead8(source, input + 1), sourceCoefficient);
      const destinationRed = Math.imul(
        bitmapRead8(destination, output + 2),
        destinationCoefficient,
      );
      bitmapWrite8(destination, output + 1, (sourceGreen + destinationGreen) >>> 16);
      const sourceRed = Math.imul(bitmapRead8(source, input + 2), sourceCoefficient);
      bitmapWrite8(destination, output + 3, denominator >>> 8);
      bitmapWrite8(destination, output + 2, (sourceRed + destinationRed) >>> 16);
    }
}

export const copyBurikoBitmapRows = withBurikoBitmapText(copyBurikoBitmapRowsPixels, {
  replace: true,
});

export const copyBurikoRgbToAlpha = withBurikoBitmapText(copyBurikoRgbToAlphaPixels, {
  replace: true,
});

export const copyBurikoAlphaToRgb = withBurikoBitmapText(copyBurikoAlphaToRgbPixels, {
  replace: true,
});

export const copyBurikoMaskToAlpha = withBurikoBitmapText(copyBurikoMaskToAlphaPixels, {
  replace: true,
  color: (_, args) => args[2] & 0xffffff,
});

export const blendBurikoRgbIntoAlphaWithTransparency = withBurikoBitmapText(
  blendBurikoRgbIntoAlphaWithTransparencyPixels,
  {opacity: (args) => (256 - args[2]) / 256},
);
