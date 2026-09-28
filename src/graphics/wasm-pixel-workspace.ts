import {reportWasmGraphicsFallback} from '../platform/runtime-advisories.js';
import {beginRuntimeSpan} from '../platform/runtime-performance.js';

export interface WasmPixelWorkspaceSpanNames {
  readonly stagingIn: string;
  readonly kernel: string;
  readonly stagingOut: string;
  readonly memoryGrowth?: string;
}

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

/** An additional source may pack a different row width, e.g. an 8-bit mask beside RGB32 rows. */
export interface WasmPixelAdditionalRows extends WasmPixelRows {
  rowBytes?: number;
}

export interface WasmPixelPlane extends WasmPixelRows {
  rowBytes: number;
  rows: number;
}

export class WasmPixelWorkspace {
  private bytes: Uint8Array | null = null;
  private readonly input: number;

  constructor(private readonly kernel: WasmPixelExports) {
    this.input = Math.ceil(Number(kernel.__heap_base.value) / 16) * 16;
  }

  /**
   * Returns false before output writes for aliases, overlapping rows or unsupported bounds.
   * With preserveDestination=false, the kernel must replace every destination byte.
   */
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
    additionalSource?: WasmPixelAdditionalRows,
    preserveDestination = true,
    spans?: WasmPixelWorkspaceSpanNames,
  ): boolean {
    const additionalRowBytes = additionalSource?.rowBytes ?? rowBytes;
    if (
      !(source.buffer instanceof ArrayBuffer) ||
      !(destination.buffer instanceof ArrayBuffer) ||
      source.buffer === destination.buffer ||
      source.buffer === this.kernel.memory.buffer ||
      destination.buffer === this.kernel.memory.buffer ||
      !Number.isSafeInteger(rowBytes) ||
      rowBytes <= 0 ||
      !Number.isSafeInteger(additionalRowBytes) ||
      additionalRowBytes <= 0 ||
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
    for (const [view, offset, pitch, width] of [
      [source, sourceOffset, sourcePitch, rowBytes],
      [destination, destinationOffset, destinationPitch, rowBytes],
      ...(additionalSource === undefined
        ? []
        : [
            [
              additionalSource.view,
              additionalSource.offset,
              additionalSource.pitch,
              additionalRowBytes,
            ] as const,
          ]),
    ] as const)
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(pitch) ||
        pitch < width ||
        offset + (rows - 1) * pitch + width > view.byteLength
      )
        return false;
    const length = rowBytes * rows,
      planeLength = Math.ceil(length / 16) * 16,
      output = this.input + planeLength,
      additionalInput = additionalSource === undefined ? 0 : output + planeLength,
      end = additionalInput === 0 ? output + length : additionalInput + additionalRowBytes * rows;
    if (!Number.isSafeInteger(end) || end > 128 * 1024 * 1024) {
      reportWasmGraphicsFallback();
      return false;
    }
    const memory = this.kernel.memory;
    if (end > memory.buffer.byteLength) {
      const finishMemoryGrowth =
        spans?.memoryGrowth === undefined ? undefined : beginRuntimeSpan(spans.memoryGrowth);
      try {
        memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536));
      } catch {
        reportWasmGraphicsFallback();
        return false;
      } finally {
        finishMemoryGrowth?.();
      }
    }
    if (this.bytes?.buffer !== memory.buffer) this.bytes = new Uint8Array(memory.buffer);
    const bytes = this.bytes;
    const finishStagingIn = spans === undefined ? undefined : beginRuntimeSpan(spans.stagingIn);
    try {
      this.copyIn(source, sourceOffset, sourcePitch, this.input, rowBytes, rows);
      // Replacement kernels write every destination byte; staging its old contents
      // is only required by kernels that blend into or selectively retain them.
      if (preserveDestination)
        this.copyIn(destination, destinationOffset, destinationPitch, output, rowBytes, rows);
      if (additionalSource !== undefined)
        this.copyIn(
          additionalSource.view,
          additionalSource.offset,
          additionalSource.pitch,
          additionalInput,
          additionalRowBytes,
          rows,
        );
    } finally {
      finishStagingIn?.();
    }
    const finishKernel = spans === undefined ? undefined : beginRuntimeSpan(spans.kernel);
    try {
      operation(this.input, output, additionalInput);
    } finally {
      finishKernel?.();
    }
    const finishStagingOut = spans === undefined ? undefined : beginRuntimeSpan(spans.stagingOut);
    try {
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
    } finally {
      finishStagingOut?.();
    }
    return true;
  }
  /**
   * run() for blending kernels that take per-plane strides in staged pixels. A plane whose
   * pitched span is at most twice its packed rows is staged as one copy with its own pitch;
   * wider pitches are packed row by row. The destination is always staged, so a span
   * returns in one copy: bytes between its rows are the unmodified staged originals.
   */
  runStrided(
    source: DataView,
    sourceOffset: number,
    sourcePitch: number,
    destination: DataView,
    destinationOffset: number,
    destinationPitch: number,
    rowBytes: number,
    rows: number,
    operation: (
      source: number,
      destination: number,
      sourceStride: number,
      destinationStride: number,
    ) => void,
  ): boolean {
    if (
      !(source.buffer instanceof ArrayBuffer) ||
      !(destination.buffer instanceof ArrayBuffer) ||
      source.buffer === destination.buffer ||
      source.buffer === this.kernel.memory.buffer ||
      destination.buffer === this.kernel.memory.buffer ||
      !Number.isSafeInteger(rowBytes) ||
      rowBytes <= 0 ||
      (rowBytes & 3) !== 0 ||
      !Number.isSafeInteger(rows) ||
      rows <= 0
    )
      return false;
    for (const [view, offset, pitch] of [
      [source, sourceOffset, sourcePitch],
      [destination, destinationOffset, destinationPitch],
    ] as const)
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(pitch) ||
        pitch < rowBytes ||
        offset + (rows - 1) * pitch + rowBytes > view.byteLength
      )
        return false;
    const packed = rowBytes * rows,
      staged = (pitch: number): number =>
        (pitch & 3) === 0 && (rows - 1) * pitch + rowBytes <= 2 * packed ? pitch : rowBytes,
      sourceStaged = staged(sourcePitch),
      destinationStaged = staged(destinationPitch),
      sourceLength = (rows - 1) * sourceStaged + rowBytes,
      destinationLength = (rows - 1) * destinationStaged + rowBytes,
      output = this.input + Math.ceil(sourceLength / 16) * 16,
      end = output + destinationLength;
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
    this.copyIn(source, sourceOffset, sourcePitch, this.input, rowBytes, rows, sourceStaged);
    this.copyIn(
      destination,
      destinationOffset,
      destinationPitch,
      output,
      rowBytes,
      rows,
      destinationStaged,
    );
    operation(this.input, output, sourceStaged >>> 2, destinationStaged >>> 2);
    const target = new Uint8Array(
      destination.buffer,
      destination.byteOffset + destinationOffset,
      (rows - 1) * destinationPitch + rowBytes,
    );
    if (destinationStaged === destinationPitch)
      target.set(bytes.subarray(output, output + destinationLength));
    else
      for (let row = 0; row < rows; row++) {
        const start = output + row * rowBytes;
        target.set(bytes.subarray(start, start + rowBytes), row * destinationPitch);
      }
    return true;
  }
  /** Stages independent plane sizes. Unless preserved, every destination byte must be overwritten. */
  transform(
    source: WasmPixelPlane,
    destination: WasmPixelPlane,
    operation: (source: number, destination: number) => void,
    preserveDestination = false,
  ): boolean {
    if (source.view.buffer === destination.view.buffer) return false;
    for (const {view, offset, pitch, rowBytes, rows} of [source, destination])
      if (
        !(view.buffer instanceof ArrayBuffer) ||
        view.buffer === this.kernel.memory.buffer ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(rowBytes) ||
        rowBytes <= 0 ||
        !Number.isSafeInteger(rows) ||
        rows <= 0 ||
        !Number.isSafeInteger(pitch) ||
        pitch < rowBytes ||
        offset + (rows - 1) * pitch + rowBytes > view.byteLength
      )
        return false;
    const sourceLength = source.rowBytes * source.rows,
      destinationLength = destination.rowBytes * destination.rows,
      output = this.input + Math.ceil(sourceLength / 16) * 16,
      end = output + Math.ceil(destinationLength / 16) * 16;
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
    this.copyIn(source.view, source.offset, source.pitch, this.input, source.rowBytes, source.rows);
    if (preserveDestination)
      this.copyIn(
        destination.view,
        destination.offset,
        destination.pitch,
        output,
        destination.rowBytes,
        destination.rows,
      );
    operation(this.input, output);
    const target = new Uint8Array(
      destination.view.buffer,
      destination.view.byteOffset + destination.offset,
      (destination.rows - 1) * destination.pitch + destination.rowBytes,
    );
    if (destination.pitch === destination.rowBytes)
      target.set(bytes.subarray(output, output + destinationLength));
    else
      for (let row = 0; row < destination.rows; row++) {
        const start = output + row * destination.rowBytes;
        target.set(bytes.subarray(start, start + destination.rowBytes), row * destination.pitch);
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
    stagedPitch = rowBytes,
  ): void {
    const source = new Uint8Array(
      view.buffer,
      view.byteOffset + offset,
      (rows - 1) * pitch + rowBytes,
    );
    // A staged pitch equal to the source pitch keeps the whole span in one copy.
    if (pitch === stagedPitch) this.bytes!.set(source, target);
    else
      for (let row = 0; row < rows; row++)
        this.bytes!.set(
          source.subarray(row * pitch, row * pitch + rowBytes),
          target + row * rowBytes,
        );
  }
}
