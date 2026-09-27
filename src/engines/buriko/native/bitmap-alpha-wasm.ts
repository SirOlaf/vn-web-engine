import {instantiateEmbeddedWasm} from '../../../core/wasm.js';
import {WasmPixelWorkspace, type WasmPixelExports} from '../../../graphics/wasm-pixel-workspace.js';
import {BURIKO_BITMAP_WASM_BINARY} from './bitmap-alpha-wasm-binary.js';
import type {BurikoBitmap} from './bitmap.js';
import type {BurikoBitmapAffineCoordinates} from './bitmap-affine.js';

interface BurikoBitmapExports extends WasmPixelExports {
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

function getKernel(): BurikoBitmapExports | null {
  if (kernel === undefined) {
    const instance = instantiateEmbeddedWasm(BURIKO_BITMAP_WASM_BINARY);
    kernel = instance === null ? null : (instance.exports as BurikoBitmapExports);
    if (kernel !== null) workspace = new WasmPixelWorkspace(kernel);
  }
  return kernel;
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
