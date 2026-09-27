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

interface BurikoBitmapExports extends WasmPixelExports {
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
    width: number,
    height: number,
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
    width: number,
    height: number,
    startX: number,
    startY: number,
    columnX: number,
    columnY: number,
    rowX: number,
    rowY: number,
    bilinear: number,
  ) => void;
  alpha_rgb: (
    source: number,
    destination: number,
    width: number,
    height: number,
    opacity: number,
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

function getKernel(): BurikoBitmapExports | null {
  if (kernel === undefined) {
    const instance = instantiateEmbeddedWasm(BURIKO_BITMAP_WASM_BINARY);
    kernel = instance === null ? null : (instance.exports as BurikoBitmapExports);
    if (kernel !== null) workspace = new WasmPixelWorkspace(kernel);
  }
  return kernel;
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
  if (width * height < BURIKO_BITMAP_WASM_MIN_PIXELS || input.buffer === output.buffer)
    return false;
  const exports = getKernel();
  if (exports === null) return false;
  return workspace!.transform(
    {
      view: input,
      offset: source.offset,
      pitch: source.stride,
      rowBytes: (pairWidth * 2 + Number(oddColumn)) * 4,
      rows: pairHeight * 2 + Number(oddRow),
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
    input.buffer === output.buffer ||
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
  return workspace!.transform(
    {
      view: input,
      offset: source.offset + top * source.stride + left * 4,
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
        width,
        height,
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

/** The caller has proven native signed-WORD source addressing and writable output bounds. */
export function tryBurikoBitmapAffineWasm(
  destination: BurikoBitmap,
  source: BurikoBitmap,
  output: DataView,
  input: DataView,
  coordinates: BurikoBitmapAffineCoordinates,
  bilinear: boolean,
): boolean {
  const width = destination.width >>> 0,
    height = destination.height >>> 0,
    pixels = width * height;
  if (
    pixels < BURIKO_BITMAP_WASM_MIN_PIXELS ||
    input.buffer === output.buffer ||
    // Small damage rectangles should not stage a disproportionately larger source plane.
    (source.width >>> 0) * (source.height >>> 0) > pixels * 16
  )
    return false;
  const exports = getKernel();
  if (exports === null) return false;
  return workspace!.transform(
    {
      view: input,
      offset: source.offset,
      pitch: source.stride,
      rowBytes: (source.width >>> 0) * 4,
      rows: source.height >>> 0,
    },
    {
      view: output,
      offset: destination.offset,
      pitch: destination.stride,
      rowBytes: width * 4,
      rows: height,
    },
    (sourcePointer, destinationPointer) =>
      exports.affine_copy(
        sourcePointer,
        destinationPointer,
        source.width >>> 0,
        source.height >>> 0,
        width,
        height,
        coordinates.startX,
        coordinates.startY,
        coordinates.columnX,
        coordinates.columnY,
        coordinates.rowX,
        coordinates.rowY,
        Number(bilinear),
      ),
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
    input.buffer === output.buffer ||
    source.stride < width * 4 ||
    destination.stride < width * 4 ||
    // Per-row staging can outweigh SIMD for narrow crops in a larger surface.
    (width < 128 && (source.stride !== width * 4 || destination.stride !== width * 4))
  )
    return false;
  const exports = getKernel();
  if (exports === null) return false;
  return workspace!.run(
    input,
    source.offset,
    source.stride,
    output,
    destination.offset,
    destination.stride,
    width * 4,
    height,
    (sourcePointer, destinationPointer) => {
      if (allChannels)
        exports.mix_all(sourcePointer, destinationPointer, width * height, transparency! >>> 1);
      else
        exports.alpha_rgb(
          sourcePointer,
          destinationPointer,
          width,
          height,
          transparency === null ? -1 : 256 - transparency,
        );
    },
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
    firstInput.buffer === output.buffer ||
    secondInput.buffer === output.buffer ||
    firstInput.buffer === secondInput.buffer ||
    first.stride < rowBytes ||
    second.stride < rowBytes ||
    destination.stride < rowBytes ||
    (width < 128 &&
      (first.stride !== rowBytes || second.stride !== rowBytes || destination.stride !== rowBytes))
  )
    return false;
  const exports = getKernel();
  if (exports === null) return false;
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
      firstInput.buffer === output.buffer ||
      secondInput.buffer === output.buffer ||
      firstInput.buffer === secondInput.buffer ||
      first.stride < rowBytes ||
      second.stride < rowBytes ||
      destination.stride < rowBytes ||
      (width < 128 &&
        (first.stride !== rowBytes ||
          second.stride !== rowBytes ||
          destination.stride !== rowBytes))
    )
      return false;
    const exports = getKernel();
    if (exports === null) return false;
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
