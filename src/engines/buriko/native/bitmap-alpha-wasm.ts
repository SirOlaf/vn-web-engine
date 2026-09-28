import {instantiateEmbeddedWasm} from '../../../core/wasm.js';
import {
  WasmPixelWorkspace,
  type WasmPixelExports,
  type WasmPixelWorkspaceSpanNames,
} from '../../../graphics/wasm-pixel-workspace.js';
import {BURIKO_BITMAP_WASM_BINARY} from './bitmap-alpha-wasm-binary.js';
import type {BurikoBitmap} from './bitmap.js';
import type {BurikoBitmapAffineCoordinates} from './bitmap-affine.js';
import {recordRuntimeMetric} from '../../../platform/runtime-performance.js';
import {byteSpansOverlap, viewsOverlap} from '../../../core/binary.js';
import {existingBurikoResidentKernel} from './bitmap-resident.js';

export interface BurikoBitmapExports extends WasmPixelExports {
  reduce_half: (
    source: number,
    destination: number,
    pairWidth: number,
    pairHeight: number,
    oddColumn: number,
    oddRow: number,
  ) => void;
  affine_alpha_rgb: (
    source: number,
    destination: number,
    sourceWidth: number,
    sourceHeight: number,
    sourceStride: number,
    width: number,
    height: number,
    destinationStride: number,
    startX: number,
    startY: number,
    columnX: number,
    columnY: number,
    rowX: number,
    rowY: number,
    bilinear: number,
    opacity: number,
  ) => void;
  affine_copy: (
    source: number,
    destination: number,
    sourceWidth: number,
    sourceHeight: number,
    sourceStride: number,
    width: number,
    height: number,
    destinationStride: number,
    startX: number,
    startY: number,
    columnX: number,
    columnY: number,
    rowX: number,
    rowY: number,
    bilinear: number,
  ) => void;
  affine_dim_copy: (
    source: number,
    destination: number,
    sourceWidth: number,
    sourceHeight: number,
    sourceStride: number,
    width: number,
    height: number,
    destinationStride: number,
    startX: number,
    startY: number,
    columnX: number,
    columnY: number,
    rowX: number,
    rowY: number,
    bilinear: number,
    alpha: number,
    coefficient: number,
  ) => void;
  transition_table: () => number;
  transition_rgb: (
    source: number,
    destination: number,
    mask: number,
    width: number,
    height: number,
  ) => void;
  alpha_rgb: (
    source: number,
    destination: number,
    width: number,
    height: number,
    opacity: number,
    sourceStride: number,
    destinationStride: number,
  ) => void;
  mix_all: (source: number, destination: number, pixels: number, destinationWeight: number) => void;
  mix_rgba: (
    first: number,
    second: number,
    destination: number,
    pixels: number,
    factor: number,
  ) => void;
  fused_rgb: (
    first: number,
    second: number,
    destination: number,
    width: number,
    height: number,
    factor: number,
    opacity: number,
  ) => void;
  dsc_decode: (input: number, inputLength: number, output: number, outputLength: number) => number;
}

let kernel: BurikoBitmapExports | null | undefined;
let workspace: WasmPixelWorkspace | null = null;

export const BURIKO_BITMAP_WASM_MIN_PIXELS = 1024;

const BURIKO_MIX_WORKSPACE_SPANS: WasmPixelWorkspaceSpanNames = {
  stagingIn: 'buriko.sprite.mix.wasm-stage-in',
  kernel: 'buriko.sprite.mix.wasm-kernel',
  stagingOut: 'buriko.sprite.mix.wasm-stage-out',
  memoryGrowth: 'buriko.sprite.mix.wasm-memory-growth',
};

/** The shared Buriko kernel instance; null when WebAssembly or SIMD is unavailable. */
export function getBurikoWasmKernel(): BurikoBitmapExports | null {
  return getKernel();
}

function getKernel(): BurikoBitmapExports | null {
  if (kernel === undefined) {
    const instance = instantiateEmbeddedWasm(BURIKO_BITMAP_WASM_BINARY);
    kernel = instance === null ? null : (instance.exports as BurikoBitmapExports);
    if (kernel !== null) workspace = new WasmPixelWorkspace(kernel);
  }
  return kernel;
}

/** One pixel span of a kernel call: a view, its first byte, row pitch, row bytes and rows. */
type ResidentSpan = readonly [
  view: DataView,
  offset: number,
  pitch: number,
  rowBytes: number,
  rows: number,
  alignment: number,
];

/**
 * Resident addresses of every span when all of them lie in the resident heap, are aligned, and
 * the destination (the first span) overlaps no source. The kernels then work in place on the
 * resident instance; otherwise the caller stages through the shared workspace.
 */
function residentAddresses(spans: readonly ResidentSpan[]): number[] | null {
  // Kernel calls never create the resident instance; only resident allocations do.
  const resident = existingBurikoResidentKernel();
  if (resident === null) return null;
  const buffer = resident.heap.buffer,
    addresses: number[] = [],
    lengths: number[] = [];
  for (const [index, [view, offset, pitch, rowBytes, rows, alignment]] of spans.entries()) {
    const address = view.byteOffset + offset,
      length = (rows - 1) * pitch + rowBytes;
    if (view.buffer !== buffer) {
      // Which plane (0 is the destination) and storage size keep a kernel call staged.
      recordRuntimeMetric('buriko.bitmap.wasm-resident', 0);
      recordRuntimeMetric('buriko.bitmap.wasm-staged-plane', index);
      recordRuntimeMetric('buriko.bitmap.wasm-staged-storage-bytes', view.byteLength);
      return null;
    }
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(length) ||
      offset + length > view.byteLength ||
      address % alignment !== 0 ||
      pitch % alignment !== 0
    )
      return null;
    addresses.push(address);
    lengths.push(length);
  }
  for (let index = 1; index < spans.length; index++)
    if (
      byteSpansOverlap(
        buffer,
        addresses[0]!,
        lengths[0]!,
        buffer,
        addresses[index]!,
        lengths[index]!,
      )
    )
      return null;
  recordRuntimeMetric('buriko.bitmap.wasm-resident', 1);
  return addresses;
}

/** Native PAVGB reduction; checked aliased or unusual views retain the JS traversal. */
export function tryBurikoBitmapReduceWasm(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  output: DataView,
  input: DataView,
  pairWidth: number,
  pairHeight: number,
  oddColumn: boolean,
  oddRow: boolean,
): boolean {
  const width = pairWidth + Number(oddColumn),
    height = pairHeight + Number(oddRow);
  if (width * height < BURIKO_BITMAP_WASM_MIN_PIXELS || viewsOverlap(input, output)) return false;
  const exports = getKernel();
  if (exports === null) return false;
  const sourceRowBytes = (pairWidth * 2 + Number(oddColumn)) * 4,
    sourceRows = pairHeight * 2 + Number(oddRow);
  // The kernel reads packed rows, so only packed resident planes run in place.
  if (source.stride === sourceRowBytes && destination.stride === width * 4) {
    const addresses = residentAddresses([
      [output, destination.offset, destination.stride, width * 4, height, 4],
      [input, source.offset, source.stride, sourceRowBytes, sourceRows, 4],
    ]);
    if (addresses !== null) {
      existingBurikoResidentKernel()!.exports.reduce_half(
        addresses[1]!,
        addresses[0]!,
        pairWidth,
        pairHeight,
        Number(oddColumn),
        Number(oddRow),
      );
      return true;
    }
  }
  return workspace!.transform(
    {
      view: input,
      offset: source.offset,
      pitch: source.stride,
      rowBytes: sourceRowBytes,
      rows: sourceRows,
    },
    {
      view: output,
      offset: destination.offset,
      pitch: destination.stride,
      rowBytes: width * 4,
      rows: height,
    },
    (sourcePointer, destinationPointer) =>
      exports.reduce_half(
        sourcePointer,
        destinationPointer,
        pairWidth,
        pairHeight,
        Number(oddColumn),
        Number(oddRow),
      ),
  );
}

/** Initialized affine alpha drawing with a conservatively bounded source footprint. */
export function tryBurikoBitmapAffineAlphaWasm(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  output: DataView,
  input: DataView,
  coordinates: BurikoBitmapAffineCoordinates,
  bilinear: boolean,
  transparency: number,
): boolean {
  const width = destination.width >>> 0,
    height = destination.height >>> 0,
    pixels = width * height;
  if (
    pixels < BURIKO_BITMAP_WASM_MIN_PIXELS ||
    source.format !== 2 ||
    destination.format !== 1 ||
    viewsOverlap(input, output) ||
    !(input.buffer instanceof ArrayBuffer) ||
    !(output.buffer instanceof ArrayBuffer) ||
    !Number.isInteger(transparency) ||
    transparency < 0 ||
    transparency >= 256
  )
    return false;

  // An affine plane reaches its extrema at its four corners. Reject accumulator
  // and nearest-rounding wrap before using those extrema to bound every source tap.
  const rounding = bilinear ? 0 : 0x8000,
    x = coordinates.startX + rounding,
    y = coordinates.startY + rounding,
    columnX = coordinates.columnX * (width - 1),
    columnY = coordinates.columnY * (width - 1),
    rowX = coordinates.rowX * (height - 1),
    rowY = coordinates.rowY * (height - 1),
    minX = Math.min(x, x + columnX, x + rowX, x + columnX + rowX),
    maxX = Math.max(x, x + columnX, x + rowX, x + columnX + rowX),
    minY = Math.min(y, y + columnY, y + rowY, y + columnY + rowY),
    maxY = Math.max(y, y + columnY, y + rowY, y + columnY + rowY);
  if (
    !Number.isSafeInteger(minX) ||
    !Number.isSafeInteger(maxX) ||
    !Number.isSafeInteger(minY) ||
    !Number.isSafeInteger(maxY) ||
    minX < -0x80000000 + rounding ||
    minY < -0x80000000 + rounding ||
    maxX > 0x7fffffff ||
    maxY > 0x7fffffff
  )
    return false;
  const left = Math.max(0, minX >> 16),
    top = Math.max(0, minY >> 16),
    right = Math.min((source.width >>> 0) - 1, (maxX >> 16) + Number(bilinear)),
    bottom = Math.min((source.height >>> 0) - 1, (maxY >> 16) + Number(bilinear));
  // No source tap is inside: alpha composition leaves the initialized target intact.
  if (right < left || bottom < top) return true;
  const sourceWidth = right - left + 1,
    sourceHeight = bottom - top + 1;
  if (sourceWidth * sourceHeight > pixels * 16) return false;
  const exports = getKernel();
  if (exports === null) return false;
  const footprint = source.offset + top * source.stride + left * 4;
  const addresses = residentAddresses([
    [output, destination.offset, destination.stride, width * 4, height, 4],
    [input, footprint, source.stride, sourceWidth * 4, sourceHeight, 4],
  ]);
  if (addresses !== null) {
    existingBurikoResidentKernel()!.exports.affine_alpha_rgb(
      addresses[1]!,
      addresses[0]!,
      sourceWidth,
      sourceHeight,
      source.stride >>> 2,
      width,
      height,
      destination.stride >>> 2,
      coordinates.startX - left * 65536,
      coordinates.startY - top * 65536,
      coordinates.columnX,
      coordinates.columnY,
      coordinates.rowX,
      coordinates.rowY,
      Number(bilinear),
      256 - transparency,
    );
    return true;
  }
  return workspace!.transform(
    {
      view: input,
      offset: footprint,
      pitch: source.stride,
      rowBytes: sourceWidth * 4,
      rows: sourceHeight,
    },
    {
      view: output,
      offset: destination.offset,
      pitch: destination.stride,
      rowBytes: width * 4,
      rows: height,
    },
    (sourcePointer, destinationPointer) =>
      exports.affine_alpha_rgb(
        sourcePointer,
        destinationPointer,
        sourceWidth,
        sourceHeight,
        sourceWidth,
        width,
        height,
        width,
        coordinates.startX - left * 65536,
        coordinates.startY - top * 65536,
        coordinates.columnX,
        coordinates.columnY,
        coordinates.rowX,
        coordinates.rowY,
        Number(bilinear),
        256 - transparency,
      ),
    true,
  );
}

/**
 * The caller has proven native signed-WORD source addressing and writable output bounds.
 * Nonzero transparency or forced alpha selects the dimming branch.
 */
export function tryBurikoBitmapAffineWasm(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  output: DataView,
  input: DataView,
  coordinates: BurikoBitmapAffineCoordinates,
  bilinear: boolean,
  transparency = 0,
  forceAlpha = false,
): boolean {
  const width = destination.width >>> 0,
    height = destination.height >>> 0,
    pixels = width * height,
    sourceWidth = source.width >>> 0,
    sourceHeight = source.height >>> 0;
  if (pixels < BURIKO_BITMAP_WASM_MIN_PIXELS || viewsOverlap(input, output)) return false;
  const exports = getKernel();
  if (exports === null) return false;
  const apply = (
    kernel: BurikoBitmapExports,
    sourcePointer: number,
    destinationPointer: number,
    sourceStride: number,
    destinationStride: number,
  ): void => {
    if (transparency === 0 && !forceAlpha)
      kernel.affine_copy(
        sourcePointer,
        destinationPointer,
        sourceWidth,
        sourceHeight,
        sourceStride,
        width,
        height,
        destinationStride,
        coordinates.startX,
        coordinates.startY,
        coordinates.columnX,
        coordinates.columnY,
        coordinates.rowX,
        coordinates.rowY,
        Number(bilinear),
      );
    else
      kernel.affine_dim_copy(
        sourcePointer,
        destinationPointer,
        sourceWidth,
        sourceHeight,
        sourceStride,
        width,
        height,
        destinationStride,
        coordinates.startX,
        coordinates.startY,
        coordinates.columnX,
        coordinates.columnY,
        coordinates.rowX,
        coordinates.rowY,
        Number(bilinear),
        forceAlpha ? 0xff000000 | 0 : 0,
        (256 - transparency) & 65535,
      );
  };
  const addresses = residentAddresses([
    [output, destination.offset, destination.stride, width * 4, height, 4],
    [input, source.offset, source.stride, sourceWidth * 4, sourceHeight, 4],
  ]);
  if (addresses !== null) {
    apply(
      existingBurikoResidentKernel()!.exports,
      addresses[1]!,
      addresses[0]!,
      source.stride >>> 2,
      destination.stride >>> 2,
    );
    return true;
  }
  // Small damage rectangles should not stage a disproportionately larger source plane.
  if (sourceWidth * sourceHeight > pixels * 16) return false;
  return workspace!.transform(
    {
      view: input,
      offset: source.offset,
      pitch: source.stride,
      rowBytes: sourceWidth * 4,
      rows: sourceHeight,
    },
    {
      view: output,
      offset: destination.offset,
      pitch: destination.stride,
      rowBytes: width * 4,
      rows: height,
    },
    (sourcePointer, destinationPointer) =>
      apply(exports, sourcePointer, destinationPointer, sourceWidth, width),
  );
}

/** Native coefficients and pair/tail rules stay here; memory staging is shared graphics code. */
export function tryBurikoBitmapAlphaWasm(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  output: DataView,
  input: DataView,
  width: number,
  height: number,
  transparency: number | null,
  allChannels = false,
): boolean {
  // Small spans are cheaper in JavaScript. Unusual coefficients retain signed-word wrapping.
  if (
    width * height < BURIKO_BITMAP_WASM_MIN_PIXELS ||
    (transparency !== null &&
      (!Number.isInteger(transparency) || transparency < 0 || transparency > 256)) ||
    viewsOverlap(input, output) ||
    source.stride < width * 4 ||
    destination.stride < width * 4
  )
    return false;
  const exports = getKernel();
  if (exports === null) return false;
  const packed = source.stride === width * 4 && destination.stride === width * 4;
  // mix_all reads packed rows; alpha_rgb takes both strides, so any aligned resident crop fits.
  if (!allChannels || packed) {
    const addresses = residentAddresses([
      [output, destination.offset, destination.stride, width * 4, height, 4],
      [input, source.offset, source.stride, width * 4, height, 4],
    ]);
    if (addresses !== null) {
      const resident = existingBurikoResidentKernel()!.exports;
      if (allChannels)
        resident.mix_all(addresses[1]!, addresses[0]!, width * height, transparency! >>> 1);
      else
        resident.alpha_rgb(
          addresses[1]!,
          addresses[0]!,
          width,
          height,
          transparency === null ? -1 : 256 - transparency,
          source.stride >>> 2,
          destination.stride >>> 2,
        );
      return true;
    }
  }
  // Per-row staging can outweigh SIMD for narrow crops in a larger surface.
  if (width < 128 && !packed) return false;
  if (allChannels)
    return workspace!.run(
      input,
      source.offset,
      source.stride,
      output,
      destination.offset,
      destination.stride,
      width * 4,
      height,
      (sourcePointer, destinationPointer) =>
        exports.mix_all(sourcePointer, destinationPointer, width * height, transparency! >>> 1),
    );
  return workspace!.runStrided(
    input,
    source.offset,
    source.stride,
    output,
    destination.offset,
    destination.stride,
    width * 4,
    height,
    (sourcePointer, destinationPointer, sourceStride, destinationStride) =>
      exports.alpha_rgb(
        sourcePointer,
        destinationPointer,
        width,
        height,
        transparency === null ? -1 : 256 - transparency,
        sourceStride,
        destinationStride,
      ),
  );
}

/** Exact bounded 03C8B0/03C580 premultiply, crossfade, and retained-destination stages. */
export function tryBurikoBitmapFusedWasm(
  destination: BurikoBitmap,
  first: BurikoBitmap,
  second: BurikoBitmap,
  output: DataView,
  firstInput: DataView,
  secondInput: DataView,
  width: number,
  height: number,
  factor: number,
  transparency: number,
): boolean {
  const rowBytes = width * 4;
  if (
    width * height < BURIKO_BITMAP_WASM_MIN_PIXELS ||
    !Number.isInteger(factor) ||
    factor < 0 ||
    factor > 256 ||
    !Number.isInteger(transparency) ||
    transparency < 0 ||
    transparency > 255 ||
    viewsOverlap(firstInput, output) ||
    viewsOverlap(secondInput, output) ||
    viewsOverlap(firstInput, secondInput) ||
    first.stride < rowBytes ||
    second.stride < rowBytes ||
    destination.stride < rowBytes
  )
    return false;
  const exports = getKernel();
  if (exports === null) return false;
  const packed =
    first.stride === rowBytes && second.stride === rowBytes && destination.stride === rowBytes;
  if (packed) {
    const addresses = residentAddresses([
      [output, destination.offset, rowBytes, rowBytes, height, 4],
      [firstInput, first.offset, rowBytes, rowBytes, height, 4],
      [secondInput, second.offset, rowBytes, rowBytes, height, 4],
    ]);
    if (addresses !== null) {
      existingBurikoResidentKernel()!.exports.fused_rgb(
        addresses[1]!,
        addresses[2]!,
        addresses[0]!,
        width,
        height,
        factor,
        256 - transparency,
      );
      return true;
    }
  }
  if (width < 128 && !packed) return false;
  return workspace!.run(
    firstInput,
    first.offset,
    first.stride,
    output,
    destination.offset,
    destination.stride,
    rowBytes,
    height,
    (firstPointer, destinationPointer, secondPointer) => {
      exports.fused_rgb(
        firstPointer,
        secondPointer,
        destinationPointer,
        width,
        height,
        factor,
        256 - transparency,
      );
    },
    {view: secondInput, offset: second.offset, pitch: second.stride},
  );
}

/** Bounded 03BEF0 RGBA crossfade with the native reciprocal's coefficient quantization. */
export function tryBurikoBitmapMixWasm(
  destination: BurikoBitmap,
  first: BurikoBitmap,
  second: BurikoBitmap,
  output: DataView,
  firstInput: DataView,
  secondInput: DataView,
  width: number,
  height: number,
  factor: number,
): boolean {
  let wasmApplied = false;
  try {
    const rowBytes = width * 4;
    if (
      destination.format !== 2 ||
      first.format !== 2 ||
      second.format !== 2 ||
      !Number.isSafeInteger(width) ||
      width <= 0 ||
      !Number.isSafeInteger(height) ||
      height <= 0 ||
      width * height < BURIKO_BITMAP_WASM_MIN_PIXELS ||
      !Number.isInteger(factor) ||
      factor < 0 ||
      factor > 256 ||
      viewsOverlap(firstInput, output) ||
      viewsOverlap(secondInput, output) ||
      viewsOverlap(firstInput, secondInput) ||
      first.stride < rowBytes ||
      second.stride < rowBytes ||
      destination.stride < rowBytes
    )
      return false;
    const exports = getKernel();
    if (exports === null) return false;
    const packed =
      first.stride === rowBytes && second.stride === rowBytes && destination.stride === rowBytes;
    if (packed) {
      const addresses = residentAddresses([
        [output, destination.offset, rowBytes, rowBytes, height, 4],
        [firstInput, first.offset, rowBytes, rowBytes, height, 4],
        [secondInput, second.offset, rowBytes, rowBytes, height, 4],
      ]);
      if (addresses !== null) {
        existingBurikoResidentKernel()!.exports.mix_rgba(
          addresses[1]!,
          addresses[2]!,
          addresses[0]!,
          width * height,
          factor,
        );
        return (wasmApplied = true);
      }
    }
    if (width < 128 && !packed) return false;
    wasmApplied = workspace!.run(
      firstInput,
      first.offset,
      first.stride,
      output,
      destination.offset,
      destination.stride,
      rowBytes,
      height,
      (firstPointer, destinationPointer, secondPointer) =>
        exports.mix_rgba(firstPointer, secondPointer, destinationPointer, width * height, factor),
      {view: secondInput, offset: second.offset, pitch: second.stride},
      false,
      BURIKO_MIX_WORKSPACE_SPANS,
    );
    return wasmApplied;
  } finally {
    recordRuntimeMetric('buriko.sprite.mix.wasm-applied', Number(wasmApplied));
  }
}

/**
 * Exact 04BC40/04B860/04BA70/04B660 RGB32 transition over separate, initialized,
 * packed-or-padded rows. `actions` maps each mask byte to skip, copy or a signed
 * coefficient, as derived by the TypeScript reference.
 */
export function tryBurikoBitmapTransitionWasm(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  mask: BurikoBitmap,
  output: DataView,
  input: DataView,
  matte: DataView,
  width: number,
  height: number,
  actions: Int32Array,
): boolean {
  const rowBytes = width * 4;
  if (
    width * height < BURIKO_BITMAP_WASM_MIN_PIXELS ||
    viewsOverlap(input, output) ||
    viewsOverlap(matte, output)
  )
    return false;
  const exports = getKernel();
  if (exports === null) return false;
  const packed =
    source.stride === rowBytes && destination.stride === rowBytes && mask.stride === width;
  if (packed) {
    const addresses = residentAddresses([
      [output, destination.offset, rowBytes, rowBytes, height, 4],
      [input, source.offset, rowBytes, rowBytes, height, 4],
      [matte, mask.offset, width, width, height, 1],
    ]);
    if (addresses !== null) {
      const resident = existingBurikoResidentKernel()!.exports;
      new Int32Array(resident.memory.buffer, resident.transition_table(), 256).set(actions);
      resident.transition_rgb(addresses[1]!, addresses[0]!, addresses[2]!, width, height);
      return true;
    }
  }
  if (width < 128 && !packed) return false;
  return workspace!.run(
    input,
    source.offset,
    source.stride,
    output,
    destination.offset,
    destination.stride,
    rowBytes,
    height,
    (sourcePointer, destinationPointer, maskPointer) => {
      new Int32Array(exports.memory.buffer, exports.transition_table(), 256).set(actions);
      exports.transition_rgb(sourcePointer, destinationPointer, maskPointer, width, height);
    },
    {view: matte, offset: mask.offset, pitch: mask.stride, rowBytes: width},
  );
}
