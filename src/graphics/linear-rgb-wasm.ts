import {instantiateEmbeddedWasm} from '../core/wasm.js';
import {reportWasmGraphicsFallback} from '../platform/runtime-advisories.js';
import {LINEAR_RGB_WASM_BINARY} from './linear-rgb-wasm-binary.js';

interface LinearRgbExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
  linear_rgb: (...args: number[]) => void;
}

function sampledSpan(
  positions: Float64Array,
  fractions: Float32Array,
  limit: number,
): [number, number] | null {
  let start = limit,
    end = 0;
  for (let i = 0; i < positions.length; i++) {
    const position = positions[i]!,
      fraction = fractions[i]!;
    if (!Number.isInteger(position) || !Number.isFinite(fraction) || fraction < 0 || fraction > 1)
      return null;
    // Include both bilinear taps, clipped against the original transparent border.
    if (position >= -1 && position < limit) {
      start = Math.min(start, Math.max(0, position));
      end = Math.max(end, Math.min(limit, position + 2));
    }
  }
  return end > start ? [start, end - start] : [0, 0];
}

/** Optional exact binary32, unfused linear RGB filtering. Coordinate policy belongs to the caller. */
export class LinearRgbWasm {
  private normalizedInitialized = false;

  private constructor(private readonly kernel: LinearRgbExports) {}

  static create(): LinearRgbWasm | null {
    const instance = instantiateEmbeddedWasm(LINEAR_RGB_WASM_BINARY);
    return instance === null ? null : new LinearRgbWasm(instance.exports as LinearRgbExports);
  }

  /** Returns false without writes when unsupported or outside the bounded acceleration domain. */
  render(
    source: Uint8Array,
    width: number,
    height: number,
    pitch: number,
    sourceX: Float64Array,
    fractionX: Float32Array,
    sourceY: Float64Array,
    fractionY: Float32Array,
    output: Uint8ClampedArray,
    outputOffset: number,
    outputPitch: number,
  ): boolean {
    const columns = sourceX.length,
      rows = sourceY.length,
      rowBytes = columns * 4;
    if (
      !Number.isSafeInteger(width) ||
      width <= 0 ||
      width >= 0x7fffffff ||
      !Number.isSafeInteger(height) ||
      height <= 0 ||
      height >= 0x7fffffff ||
      !Number.isSafeInteger(pitch) ||
      pitch < width * 4 ||
      (height - 1) * pitch + width * 4 > source.length ||
      columns === 0 ||
      rows === 0 ||
      fractionX.length !== columns ||
      fractionY.length !== rows ||
      !Number.isSafeInteger(outputOffset) ||
      outputOffset < 0 ||
      !Number.isSafeInteger(outputPitch) ||
      outputPitch < rowBytes ||
      outputOffset + (rows - 1) * outputPitch + rowBytes > output.length ||
      source.buffer === output.buffer
    )
      return false;
    const horizontalSpan = sampledSpan(sourceX, fractionX, width),
      verticalSpan = sampledSpan(sourceY, fractionY, height);
    if (horizontalSpan === null || verticalSpan === null) return false;
    const [sourceLeft, sampledWidth] = horizontalSpan,
      [sourceTop, sampledHeight] = verticalSpan,
      sampledPitch = sampledWidth * 4,
      sampledBytes = sampledPitch * sampledHeight;

    let end = Number(this.kernel.__heap_base.value);
    const allocate = (length: number): number => {
      const offset = Math.ceil(end / 16) * 16;
      end = offset + length;
      return offset;
    };
    // A fixed table location survives changes of output size and memory growth.
    const normalized = allocate(256 * 4),
      input = allocate(sampledBytes),
      x = allocate(columns * 4),
      fx = allocate(columns * 4),
      y = allocate(rows * 4),
      fy = allocate(rows * 4),
      top = allocate(columns * 16),
      bottom = allocate(columns * 16),
      destination = allocate(rowBytes * rows);
    // Preserve the original acceleration domain as well as bounding compact scratch.
    const originalEnd =
      end + Math.ceil(source.length / 16) * 16 - Math.ceil(sampledBytes / 16) * 16;
    if (!Number.isSafeInteger(originalEnd) || originalEnd > 128 * 1024 * 1024) {
      reportWasmGraphicsFallback();
      return false;
    }
    const memory = this.kernel.memory;
    if (end > memory.buffer.byteLength) {
      try {
        memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536));
      } catch {
        reportWasmGraphicsFallback();
        return false;
      }
    }
    const buffer = memory.buffer;
    const stagedSource = new Uint8Array(buffer, input, sampledBytes),
      sourceOffset = sourceTop * pitch + sourceLeft * 4;
    if (sampledPitch === pitch)
      stagedSource.set(source.subarray(sourceOffset, sourceOffset + sampledBytes));
    else if (sampledBytes !== 0)
      for (let row = 0; row < sampledHeight; row++) {
        const start = sourceOffset + row * pitch;
        stagedSource.set(source.subarray(start, start + sampledPitch), row * sampledPitch);
      }
    const xs = new Int32Array(buffer, x, columns),
      ys = new Int32Array(buffer, y, rows);
    // All farther-out integer positions have two transparent-black taps.
    for (let i = 0; i < columns; i++)
      xs[i] = sourceX[i]! < -1 || sourceX[i]! >= width ? -2 : sourceX[i]! - sourceLeft;
    for (let i = 0; i < rows; i++)
      ys[i] = sourceY[i]! < -1 || sourceY[i]! >= height ? -2 : sourceY[i]! - sourceTop;
    new Float32Array(buffer, fx, columns).set(fractionX);
    new Float32Array(buffer, fy, rows).set(fractionY);
    if (!this.normalizedInitialized) {
      const table = new Float32Array(buffer, normalized, 256);
      for (let i = 0; i < table.length; i++) table[i] = i / 255;
      this.normalizedInitialized = true;
    }
    this.kernel.linear_rgb(
      input,
      sampledWidth,
      sampledHeight,
      sampledPitch,
      x,
      fx,
      y,
      fy,
      columns,
      rows,
      top,
      bottom,
      normalized,
      destination,
    );
    const pixels = new Uint8Array(buffer, destination, rowBytes * rows);
    if (outputPitch === rowBytes) output.set(pixels, outputOffset);
    else
      for (let row = 0; row < rows; row++)
        output.set(
          pixels.subarray(row * rowBytes, (row + 1) * rowBytes),
          outputOffset + row * outputPitch,
        );
    return true;
  }
}
