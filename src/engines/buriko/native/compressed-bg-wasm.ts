import {instantiateEmbeddedWasm} from '../../../core/wasm.js';
import type {CooperativeTask} from '../../../core/cooperative-task.js';
import {
  decodeCompressedBgLegacyAsync,
  legacyImageHeader,
  type BurikoImage,
  type BurikoImageDestination,
  type CompressedBgLegacyPlan,
} from '../../../formats/buriko/compressed-bg.js';
import {beginRuntimeSpan, recordRuntimeMetric} from '../../../platform/runtime-performance.js';
import {BURIKO_BITMAP_WASM_BINARY} from './bitmap-alpha-wasm-binary.js';

interface BurikoCbgExports {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
  cbg_state: () => number;
  cbg_tables: (tables: number, children: number, root: number, prefixBits: number) => void;
  cbg_entropy: (
    tables: number,
    children: number,
    root: number,
    prefixBits: number,
    window: number,
    windowBytes: number,
    finalWindow: number,
    bit: number,
    output: number,
    index: number,
    end: number,
    total: number,
  ) => number;
  cbg_runs: (
    input: number,
    inputLength: number,
    cursor: number,
    output: number,
    size: number,
    written: number,
    literal: number,
    budget: number,
  ) => number;
  cbg_predict: (
    residuals: number,
    output: number,
    width: number,
    channels: number,
    firstRow: number,
    endRow: number,
  ) => void;
}

/** Staged bitstream bytes per entropy step; must exceed the kernel's 128-byte window margin. */
const CBG_WINDOW_BYTES = 128 * 1024;
const CBG_SYMBOLS_PER_STEP = 128 * 1024;
const CBG_RUN_BYTES_PER_STEP = 512 * 1024;
const CBG_PREDICTOR_BYTES_PER_STEP = 256 * 1024;
const CBG_WASM_MAX_WORKSPACE = 256 * 1024 * 1024;
/** An idle instance keeps its grown memory; larger ones are left to the collector. */
const CBG_WASM_RETAINED_MEMORY = 32 * 1024 * 1024;

let idle: BurikoCbgExports | null = null;

/**
 * Each decode leases a private kernel instance. Its linear memory holds the bitstream window,
 * lookup tables, intermediate symbols, residuals and pixels while the decode yields to the host.
 * The shared kernel's scratch memory cannot: other kernels reuse it during those yields.
 */
function acquireInstance(): BurikoCbgExports | null {
  const pooled = idle;
  if (pooled !== null) {
    idle = null;
    return pooled;
  }
  const instance = instantiateEmbeddedWasm(BURIKO_BITMAP_WASM_BINARY);
  return instance === null ? null : (instance.exports as unknown as BurikoCbgExports);
}

function releaseInstance(kernel: BurikoCbgExports): void {
  if (idle === null && kernel.memory.buffer.byteLength <= CBG_WASM_RETAINED_MEMORY) idle = kernel;
}

/** 0x1400bfa50 legacy decoding, with Wasm entropy, run, and predictor stages when available. */
export function decodeBurikoCompressedBgLegacyAsync(
  bytes: Uint8Array,
  destination?: BurikoImageDestination,
  beforeResume?: () => void,
): Promise<BurikoImage> {
  return decodeCompressedBgLegacyAsync(bytes, destination, beforeResume, decodeLegacyStagesWasm);
}

function overlaps(first: Uint8Array, second: Uint8Array): boolean {
  return (
    first.buffer === second.buffer &&
    first.byteOffset < second.byteOffset + second.byteLength &&
    second.byteOffset < first.byteOffset + first.byteLength
  );
}

/**
 * Wasm entropy, run, and predictor stages. The entropy and run stages write only
 * instance memory, so any kernel failure returns null before a destination pixel is
 * written, and the reference stages rerun to raise the exact native error. The
 * predictor cannot fail. Each step reads the source bitstream window it consumes and
 * restages the destination row above its first row, so host writes between steps are
 * observed as the reference observes them. Rows publish their pixels, then their
 * initialization. When the pixel and initialization views overlap, every row
 * restages its upper row after the previous row's initialization is published.
 */
function* decodeLegacyStagesWasm(
  plan: CompressedBgLegacyPlan,
): CooperativeTask<{header: Uint8Array; pixels: Uint8Array} | null> {
  const {width, height, depth, channels, size, outputChannels, intermediateSize} = plan;
  if (width === 0 || height === 0 || (depth !== 8 && depth !== 24 && depth !== 32)) {
    recordRuntimeMetric('buriko.decode.cbg.wasm-applied', 0);
    return null;
  }
  const prefixBits = intermediateSize >= 65536 ? 16 : 12,
    stride = width * outputChannels,
    outputSize = stride * height,
    base = 16,
    align = (value: number) => Math.ceil(value / 16) * 16;
  // Layout, from the aligned heap base: tables, children, window (eight padding bytes),
  // intermediate (slack for four-symbol stores), residuals (a masked fourth byte is read after
  // the last 24-bit residual), and expanded 24-bit pixels. 8- and 32-bit pixels replace residuals.
  const tablesOffset = 0,
    childrenOffset = tablesOffset + 7 * (1 << prefixBits),
    windowOffset = childrenOffset + 2048,
    intermediateOffset = windowOffset + align(CBG_WINDOW_BYTES + 8),
    residualsOffset = intermediateOffset + align(intermediateSize + 4),
    outputOffset = depth === 24 ? residualsOffset + align(size + 1) : residualsOffset,
    workspace = (depth === 24 ? outputOffset + outputSize : residualsOffset + size) + base;
  if (workspace > CBG_WASM_MAX_WORKSPACE) {
    recordRuntimeMetric('buriko.decode.cbg.wasm-applied', 0);
    return null;
  }
  const kernel = acquireInstance();
  if (kernel === null) {
    recordRuntimeMetric('buriko.decode.cbg.wasm-applied', 0);
    return null;
  }
  let finishPhase: ReturnType<typeof beginRuntimeSpan> = undefined;
  try {
    const memory = kernel.memory,
      heapBase = align(Number(kernel.__heap_base.value)),
      end = heapBase + workspace;
    if (end > memory.buffer.byteLength) {
      try {
        memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536));
      } catch {
        recordRuntimeMetric('buriko.decode.cbg.wasm-applied', 0);
        return null;
      }
    }
    const heap = new Uint8Array(memory.buffer),
      state = new Uint32Array(memory.buffer, kernel.cbg_state(), 4),
      tables = heapBase + tablesOffset,
      children = heapBase + childrenOffset,
      window = heapBase + windowOffset,
      intermediate = heapBase + intermediateOffset,
      residuals = heapBase + residualsOffset,
      output = heapBase + outputOffset,
      {root} = plan.tree,
      bitBytes = plan.bitBytes;

    finishPhase = beginRuntimeSpan('buriko.decode.cbg.entropy');
    const childSlots = new Uint16Array(memory.buffer, children, 1024).fill(0xffff);
    plan.tree.children.forEach((pair, node) => {
      for (let bit = 0; bit < pair.length; bit++) childSlots[node * 2 + bit] = pair[bit]!;
    });
    kernel.cbg_tables(tables, children, root, prefixBits);
    yield;
    let bitPosition = 0;
    for (let index = 0; index < intermediateSize;) {
      const first = Math.floor(bitPosition / 8),
        last = Math.min(bitBytes.length, first + CBG_WINDOW_BYTES),
        windowBytes = last - first;
      heap.set(bitBytes.subarray(first, last), window);
      heap.fill(0, window + windowBytes, window + windowBytes + 8);
      const next = kernel.cbg_entropy(
        tables,
        children,
        root,
        prefixBits,
        window,
        windowBytes,
        Number(last === bitBytes.length),
        bitPosition - first * 8,
        intermediate,
        index,
        Math.min(intermediateSize, index + CBG_SYMBOLS_PER_STEP),
        intermediateSize,
      );
      if (next < 0) {
        recordRuntimeMetric('buriko.decode.cbg.wasm-applied', 0);
        return null;
      }
      bitPosition = first * 8 + state[0]!;
      index = next;
      yield;
    }
    finishPhase?.({
      sourceBytes: bitBytes.length,
      intermediateBytes: intermediateSize,
      prefixBits,
      wasm: 1,
    });

    finishPhase = beginRuntimeSpan('buriko.decode.cbg.runs');
    for (let cursor = 0, written = 0, literal = 1; ;) {
      const status = kernel.cbg_runs(
        intermediate,
        intermediateSize,
        cursor,
        residuals,
        size,
        written,
        literal,
        CBG_RUN_BYTES_PER_STEP,
      );
      if (status < 0) {
        recordRuntimeMetric('buriko.decode.cbg.wasm-applied', 0);
        return null;
      }
      if (status === 0) break;
      cursor = state[0]!;
      written = state[1]!;
      literal = state[2]!;
      yield;
    }
    finishPhase?.({intermediateBytes: intermediateSize, residualBytes: size, wasm: 1});

    finishPhase = beginRuntimeSpan('buriko.decode.cbg.predictor');
    recordRuntimeMetric('buriko.decode.cbg.wasm-applied', 1);
    const header = legacyImageHeader(plan),
      {destination} = plan,
      rowsPerStep = Math.max(1, Math.floor(CBG_PREDICTOR_BYTES_PER_STEP / stride));
    for (let y = 0; y < height;) {
      const endRow = Math.min(height, y + rowsPerStep);
      if (destination === undefined) {
        kernel.cbg_predict(residuals, output, width, channels, y, endRow);
      } else {
        // Borrowed views are read afresh after every host yield.
        const pixels = destination.bytes,
          initialized = destination.initialized,
          rowwise = overlaps(pixels, initialized);
        for (let row = y; row < endRow; row++) {
          if (row > 0 && (row === y || rowwise)) {
            const above = 16 + (row - 1) * stride;
            heap.set(pixels.subarray(above, above + stride), output + (row - 1) * stride);
          }
          if (row === y || rowwise)
            kernel.cbg_predict(residuals, output, width, channels, row, rowwise ? row + 1 : endRow);
          const start = output + row * stride;
          pixels.set(heap.subarray(start, start + stride), 16 + row * stride);
          initialized.fill(1, 16 + row * stride, 16 + (row + 1) * stride);
        }
      }
      y = endRow;
      yield;
    }
    const pixels =
      destination === undefined
        ? heap.slice(output, output + outputSize)
        : destination.bytes.subarray(16, 16 + outputSize);
    finishPhase?.({width, height, depth, outputBytes: pixels.length, wasm: 1});
    finishPhase = undefined;
    return {header, pixels};
  } finally {
    finishPhase?.();
    releaseInstance(kernel);
  }
}
