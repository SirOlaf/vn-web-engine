import {reportWasmGraphicsFallback} from '../platform/runtime-advisories.js';

/** Linear-memory staging for synchronous pixel kernels with separate input/output rows. */
export interface WasmPixelExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
}

export interface WasmPixelRows {
  view: DataView;
  offset: number;
  pitch: number;
}

export class WasmPixelWorkspace {
  private bytes: Uint8Array | null = null;
  private readonly input: number;

  constructor(private readonly kernel: WasmPixelExports) {
    this.input = Math.ceil(Number(kernel.__heap_base.value) / 16) * 16;
  }

  /** Returns false before output writes for aliases, overlapping rows or unsupported bounds. */
  run(
    source: DataView,
    sourceOffset: number,
    sourcePitch: number,
    destination: DataView,
    destinationOffset: number,
    destinationPitch: number,
    rowBytes: number,
    rows: number,
    operation: (source: number, destination: number, additionalSource: number) => void,
    additionalSource?: WasmPixelRows,
  ): boolean {
    if (
      !(source.buffer instanceof ArrayBuffer) ||
      !(destination.buffer instanceof ArrayBuffer) ||
      source.buffer === destination.buffer ||
      source.buffer === this.kernel.memory.buffer ||
      destination.buffer === this.kernel.memory.buffer ||
      !Number.isSafeInteger(rowBytes) ||
      rowBytes <= 0 ||
      !Number.isSafeInteger(rows) ||
      rows <= 0
    )
      return false;
    if (
      additionalSource !== undefined &&
      (!(additionalSource.view.buffer instanceof ArrayBuffer) ||
        additionalSource.view.buffer === source.buffer ||
        additionalSource.view.buffer === destination.buffer ||
        additionalSource.view.buffer === this.kernel.memory.buffer)
    )
      return false;
    for (const [view, offset, pitch] of [
      [source, sourceOffset, sourcePitch],
      [destination, destinationOffset, destinationPitch],
      ...(additionalSource === undefined
        ? []
        : [[additionalSource.view, additionalSource.offset, additionalSource.pitch] as const]),
    ] as const)
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(pitch) ||
        pitch < rowBytes ||
        offset + (rows - 1) * pitch + rowBytes > view.byteLength
      )
        return false;
    const length = rowBytes * rows,
      planeLength = Math.ceil(length / 16) * 16,
      output = this.input + planeLength,
      additionalInput = additionalSource === undefined ? 0 : output + planeLength,
      end = (additionalInput === 0 ? output : additionalInput) + length;
    if (!Number.isSafeInteger(end) || end > 128 * 1024 * 1024) {
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
    if (this.bytes?.buffer !== memory.buffer) this.bytes = new Uint8Array(memory.buffer);
    const bytes = this.bytes;
    this.copyIn(source, sourceOffset, sourcePitch, this.input, rowBytes, rows);
    this.copyIn(destination, destinationOffset, destinationPitch, output, rowBytes, rows);
    if (additionalSource !== undefined)
      this.copyIn(
        additionalSource.view,
        additionalSource.offset,
        additionalSource.pitch,
        additionalInput,
        rowBytes,
        rows,
      );
    operation(this.input, output, additionalInput);
    const target = new Uint8Array(
      destination.buffer,
      destination.byteOffset + destinationOffset,
      (rows - 1) * destinationPitch + rowBytes,
    );
    if (destinationPitch === rowBytes) target.set(bytes.subarray(output, output + length));
    else
      for (let row = 0; row < rows; row++) {
        const start = output + row * rowBytes;
        target.set(bytes.subarray(start, start + rowBytes), row * destinationPitch);
      }
    return true;
  }
  private copyIn(
    view: DataView,
    offset: number,
    pitch: number,
    target: number,
    rowBytes: number,
    rows: number,
  ): void {
    const source = new Uint8Array(
      view.buffer,
      view.byteOffset + offset,
      (rows - 1) * pitch + rowBytes,
    );
    if (pitch === rowBytes) this.bytes!.set(source, target);
    else
      for (let row = 0; row < rows; row++)
        this.bytes!.set(
          source.subarray(row * pitch, row * pitch + rowBytes),
          target + row * rowBytes,
        );
  }
}
