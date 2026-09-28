import {withBurikoBitmapText} from './bitmap-dom-text.js';
import {
  burikoBitmapRectangle,
  cropBurikoBitmap,
  intersectBurikoBitmapRectangle,
  translateBurikoBitmapRectangle,
  type BurikoBitmap,
} from './bitmap.js';
import {burikoSignedProduct16, saturateBurikoByte} from './bitmap-pairs.js';
import {bitmapRead8, bitmapRead32, bitmapWrite32} from './bitmap-scalar.js';
import {tryBurikoBitmapTransitionWasm} from './bitmap-alpha-wasm.js';
import {transitionLegacy169BitmapPixels} from './legacy-169-bitmap-transition.js';

function cvtt32(value: number): number {
  const integer = Math.trunc(value);
  return !Number.isFinite(integer) || integer < -0x80000000 || integer > 0x7fffffff
    ? -0x80000000
    : integer | 0;
}

/** 04BA70/04B660 use separate, ordered double operations and signed CVTT32. */
function triangleTable(parameter: number, extra: number): number[] {
  const q = (Math.imul(parameter, 2) + 1) >>> 0,
    period = 256 / q,
    frequency = q / 256;
  const table: number[] = [];
  for (let index = 0; index < (extra === 0 ? 256 : 257); index++) {
    const band = cvtt32(index * frequency);
    let residual = index - band * period;
    if ((band & 1) !== 0) residual = period - residual;
    const scaled = residual * 256;
    table.push(
      extra === 0
        ? (cvtt32(scaled * frequency) << 4) & 65535
        : (cvtt32(scaled * (extra >>> 0) * frequency) >> 4) & 65535,
    );
  }
  return table;
}

// Mask-byte actions shared with the Wasm kernel. Other entries are signed
// coefficients k for delta = ((difference << 4) * k) >> 16.
const TRANSITION_COPY = 0x10000,
  TRANSITION_SKIP = 0x20000;

/** Positive-stride rows whose whole envelope is in bounds and already initialized. */
function transitionRows(bitmap: BurikoBitmap, rowBytes: number, rows: number): DataView | null {
  if (!Number.isSafeInteger(bitmap.stride) || bitmap.stride < rowBytes) return null;
  const view =
    bitmap.storage?.initializedView(bitmap.offset, (rows - 1) * bitmap.stride + rowBytes) ?? null;
  return view !== null && view.buffer instanceof ArrayBuffer ? view : null;
}

/**
 * Checked-once traversal of transition32. Every read in the envelope is proven
 * valid, so no pixel can fault; the JavaScript loop keeps per-pixel order for
 * shared storage, and Wasm is used only for separate buffers.
 */
function transition32Fast(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  mask: BurikoBitmap,
  width: number,
  height: number,
  actions: Int32Array,
): boolean {
  if (width === 0 || height === 0) return false;
  const output = transitionRows(destination, width * 4, height),
    input = transitionRows(source, width * 4, height),
    matte = transitionRows(mask, width, height);
  if (output === null || input === null || matte === null) return false;
  if (
    !tryBurikoBitmapTransitionWasm(
      destination,
      source,
      mask,
      output,
      input,
      matte,
      width,
      height,
      actions,
    )
  ) {
    const levels = mask.storage!.bytes;
    for (let y = 0; y < height; y++) {
      const maskRow = mask.offset + y * mask.stride,
        outputRow = destination.offset + y * destination.stride,
        inputRow = source.offset + y * source.stride;
      for (let x = 0; x < width; x++) {
        const action = actions[levels[maskRow + x]!]!;
        if (action === TRANSITION_SKIP) continue;
        const offset = outputRow + x * 4,
          pixel = input.getUint32(inputRow + x * 4, true);
        if (action === TRANSITION_COPY) {
          output.setUint32(offset, pixel, true);
          continue;
        }
        const old = output.getUint32(offset, true);
        let result = old & 0xff000000;
        for (let shift = 0; shift < 24; shift += 8) {
          const previous = (old >>> shift) & 255,
            delta = (((((pixel >>> shift) & 255) - previous) << 4) * action) >> 16;
          result |= saturateBurikoByte(previous + delta) << shift;
        }
        output.setUint32(offset, result, true);
      }
    }
  }
  // The envelope was initialized, so row publication retains validity state.
  for (let y = 0; y < height; y++)
    destination.storage!.written(destination.offset + y * destination.stride, width * 4);
  return true;
}

/** Exact04BC40/04B860/04BA70/04B660 scalar MOVD traversal on shared storage. */
function transition32(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  mask: BurikoBitmap,
  parameter: number,
  blend: number,
  extra: number,
): void {
  const small = parameter >>> 0 < 8;
  let coefficients: number[] = [];
  if (!small) coefficients = triangleTable(parameter, extra);
  else if (extra !== 0) {
    let accumulator = 0;
    for (let index = 0; index <= 128; index++) {
      coefficients.push((accumulator >>> 3) & 65535);
      accumulator = (accumulator + 256 - extra) >>> 0;
    }
  }
  const bounds = small && extra === 0 ? destination : source;
  const bias = small ? (Math.imul(~(1 << parameter), blend) + 256) | 0 : Math.imul(128 - blend, 2);
  // Every per-pixel decision depends only on the mask byte. The small, extra-free
  // Q7 product is rescaled: (d * c) >> 7 === ((d << 4) * (c * 32)) >> 16 for c < 128.
  const actions = new Int32Array(256);
  for (let byte = 0; byte < 256; byte++) {
    const coverage = ((small ? byte << parameter : byte) + bias) | 0;
    actions[byte] =
      coverage <= 0
        ? TRANSITION_SKIP
        : extra === 0 && coverage >= 256
          ? TRANSITION_COPY
          : small && extra === 0
            ? (coverage >> 1) * 32
            : (coefficients[small ? Math.min(128, coverage >> 1) : Math.min(256, coverage)]! <<
                16) >>
              16;
  }
  if (transition32Fast(destination, source, mask, bounds.width >>> 0, bounds.height >>> 0, actions))
    return;
  for (let y = 0; y < bounds.height >>> 0; y++) {
    for (let x = 0; x < bounds.width >>> 0; x++) {
      const byte = bitmapRead8(mask, mask.offset + y * mask.stride + x);
      const coverage = ((small ? byte << parameter : byte) + bias) | 0;
      if (coverage <= 0) continue;
      const output = destination.offset + y * destination.stride + x * 4;
      const input = source.offset + y * source.stride + x * 4;
      if (extra === 0 && coverage >= 256) {
        bitmapWrite32(destination, output, bitmapRead32(source, input));
        continue;
      }
      const old = bitmapRead32(destination, output),
        pixel = bitmapRead32(source, input);
      const coefficient =
        small && extra === 0
          ? coverage >> 1
          : (coefficients[small ? Math.min(128, coverage >> 1) : Math.min(256, coverage)]! << 16) >>
            16;
      let result = old & 0xff000000;
      for (let shift = 0; shift < 24; shift += 8) {
        const previous = (old >>> shift) & 255,
          difference = ((pixel >>> shift) & 255) - previous;
        const delta =
          small && extra === 0
            ? burikoSignedProduct16(difference, coefficient) >> 7
            : Math.floor(((difference << 4) * coefficient) / 65536);
        result |= saturateBurikoByte(previous + delta) << shift;
      }
      bitmapWrite32(destination, output, result);
    }
  }
}

/** 04E3A0 clips three descriptors before actual04BA00/04BD70 format dispatch. */
function transitionBurikoBitmapPixels(
  destination: BurikoBitmap,
  x: number,
  y: number,
  source: BurikoBitmap,
  mask: BurikoBitmap,
  parameter: number,
  blend: number,
  extra: number,
  maskAtDestination: boolean,
  compatibility: '1.69' | '1.72' = '1.72',
): 0 | 1 | 3 | 4 | 7 | 8 {
  const output = {...destination},
    input = {...source},
    matte = {...mask};
  if (matte.format !== 3) return 7;
  if (!maskAtDestination && (input.width !== matte.width || input.height !== matte.height))
    return 8;
  if (blend >>> 0 > 256) return 3;
  const area = burikoBitmapRectangle(input),
    outputArea = burikoBitmapRectangle(output);
  translateBurikoBitmapRectangle(outputArea, -x, -y);
  if (!intersectBurikoBitmapRectangle(area, outputArea)) return 4;
  if (!maskAtDestination) {
    cropBurikoBitmap(input, area);
    cropBurikoBitmap(matte, area);
    translateBurikoBitmapRectangle(area, x, y);
  } else {
    const maskArea = burikoBitmapRectangle(matte);
    translateBurikoBitmapRectangle(maskArea, -x, -y);
    if (!intersectBurikoBitmapRectangle(area, maskArea)) return 4;
    cropBurikoBitmap(input, area);
    translateBurikoBitmapRectangle(area, x, y);
    intersectBurikoBitmapRectangle(area, burikoBitmapRectangle(matte));
    cropBurikoBitmap(matte, area);
  }
  cropBurikoBitmap(output, area);
  if (output.format !== input.format) return 1;
  if (input.format === 1) {
    const transition = compatibility === '1.69' ? transitionLegacy169BitmapPixels : transition32;
    transition(output, input, matte, parameter >>> 0, blend >>> 0, extra >>> 0);
  }
  return 0;
}

export const transitionBurikoBitmap = withBurikoBitmapText(transitionBurikoBitmapPixels, {
  source: 3,
  applied: (result, args) => result === 0 && args[3].format === 1,
  map: (x, y, args) => [x + args[1], y + args[2]],
});
