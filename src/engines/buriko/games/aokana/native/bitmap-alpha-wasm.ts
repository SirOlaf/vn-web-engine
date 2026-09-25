import {instantiateEmbeddedWasm} from '../../../../../core/wasm.js';
import {
  WasmPixelWorkspace,
  type WasmPixelExports,
} from '../../../../../graphics/wasm-pixel-workspace.js';
import {AOKANA_BITMAP_WASM_BINARY} from './bitmap-alpha-wasm-binary.js';
import type {AokanaBitmap} from './bitmap.js';

interface AokanaBitmapExports extends WasmPixelExports {
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

let kernel: AokanaBitmapExports | null | undefined;
let workspace: WasmPixelWorkspace | null = null;

export const AOKANA_BITMAP_WASM_MIN_PIXELS = 1024;

function getKernel(): AokanaBitmapExports | null {
  if (kernel === undefined) {
    const instance = instantiateEmbeddedWasm(AOKANA_BITMAP_WASM_BINARY);
    kernel = instance === null ? null : (instance.exports as AokanaBitmapExports);
    if (kernel !== null) workspace = new WasmPixelWorkspace(kernel);
  }
  return kernel;
}

/** Native coefficients and pair/tail rules stay here; memory staging is shared graphics code. */
export function tryAokanaBitmapAlphaWasm(
  destination: AokanaBitmap,
  source: AokanaBitmap,
  output: DataView,
  input: DataView,
  width: number,
  height: number,
  transparency: number | null,
  allChannels = false,
): boolean {
  // Small spans are cheaper in JavaScript. Unusual coefficients retain signed-word wrapping.
  if (
    width * height < AOKANA_BITMAP_WASM_MIN_PIXELS ||
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
export function tryAokanaBitmapFusedWasm(
  destination: AokanaBitmap,
  first: AokanaBitmap,
  second: AokanaBitmap,
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
    width * height < AOKANA_BITMAP_WASM_MIN_PIXELS ||
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
