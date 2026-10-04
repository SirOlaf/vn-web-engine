import {instantiateEmbeddedWasm} from '../../../core/wasm.js';
import {BURIKO_BITMAP_WASM_BINARY} from './bitmap-alpha-wasm-binary.js';
import type {BurikoBfTree} from './bf-entropy.js';
import type {BurikoBfSurface} from './bf-frame.js';

interface BurikoBfExports {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
  bf_decode_alpha: (frame: number) => number;
  bf_decode_rows: (frame: number) => number;
}

/** A frame prepared by `prepareBurikoBfFrame`, before any work item has run. */
export interface BurikoBfWasmFrame {
  readonly frame: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  /** 0 without alpha (depth != 32), else the validated codec. */
  readonly alphaMode: number;
  readonly alphaStart: number;
  /** Codec 2: its weights' tree and the offset of its symbol bits after `alphaStart`. */
  readonly alphaTree: BurikoBfTree | null;
  readonly alphaBitsStart: number;
  readonly frameExtent: number;
  readonly columns: number;
  readonly rows: number;
  readonly alignedWidth: number;
  readonly alignedHeight: number;
  readonly descriptors: readonly {start: number; count: number; dataStart: number; limit: number}[];
  readonly dcTree: BurikoBfTree;
  readonly acTree: BurikoBfTree;
  readonly quantization: Uint8Array;
  readonly colorTable: Float32Array;
}

const FIELDS = 26;
const UNDEFINED = 0xffffffff;
// Coefficients, their definition bytes and three surface planes of a 4K frame fit.
const BF_WASM_MAX_WORKSPACE = 512 * 1024 * 1024;
/** A playing 1920x1080 movie reuses one idle instance; larger ones are left to the collector. */
const BF_WASM_RETAINED_MEMORY = 128 * 1024 * 1024;

let idle: BurikoBfExports | null = null;

/**
 * Each frame leases a private kernel instance: its staged pixels stay live while the frame's work
 * items yield to the host, and another frame may decode during those yields.
 */
function acquireInstance(): BurikoBfExports | null {
  const pooled = idle;
  if (pooled !== null) {
    idle = null;
    return pooled;
  }
  const instance = instantiateEmbeddedWasm(BURIKO_BITMAP_WASM_BINARY);
  return instance === null ? null : (instance.exports as unknown as BurikoBfExports);
}

function releaseInstance(kernel: BurikoBfExports): void {
  if (idle === null && kernel.memory.buffer.byteLength <= BF_WASM_RETAINED_MEMORY) idle = kernel;
}

/** A frame decoded in instance memory, published one work item at a time. */
export interface BurikoBfWasmDecoded {
  /** The alpha work item: the surface as staged after alpha, before any row. */
  publishAlpha(surface: BurikoBfSurface): void;
  /** One row work item: its band of eight pixel rows. */
  publishRow(surface: BurikoBfSurface, row: number): void;
  /** Return the instance once every work item has published. */
  release(): void;
}

/** leaves, capacity, 256 lookup entries `(length << 24) | node`, then the child pairs. */
function encodeTree(tree: BurikoBfTree): Uint32Array {
  const capacity = tree.children.length,
    encoded = new Uint32Array(258 + capacity * 2);
  encoded[0] = tree.leaves;
  encoded[1] = capacity;
  for (let prefix = 0; prefix < 256; prefix++) {
    const entry = tree.lookup[prefix];
    encoded[2 + prefix] =
      entry === undefined ? UNDEFINED : ((entry.length << 24) | entry.node) >>> 0;
  }
  tree.children.forEach(([zero, one], node) => {
    encoded[258 + node * 2] = zero!;
    encoded[259 + node * 2] = one!;
  });
  return encoded;
}

/**
 * Decode a whole frame through the bitmap Wasm module without touching `surface`. Null means
 * the kernel is unavailable, or the frame reaches a case where the reference decoder raises,
 * which the caller then runs to raise the exact native error.
 */
export function decodeBurikoBfFrameWasm(
  input: BurikoBfWasmFrame,
  surface: BurikoBfSurface,
): BurikoBfWasmDecoded | null {
  const kernel = acquireInstance();
  if (kernel === null) return null;
  const pixels = surface.bytes,
    initialized = surface.initialized,
    length = pixels.length;
  // Fully initialized surfaces, the steady state of a playing movie, need no definition plane.
  const tracked = initialized.indexOf(0) !== -1;
  const coefficientCount = input.alignedWidth * input.alignedHeight * 3,
    decodedLength = input.alphaMode === 2 ? input.alignedWidth * input.alignedHeight * 2 : 0;
  const trees = [input.dcTree, input.acTree, input.alphaTree].map((tree) =>
    tree === null ? null : encodeTree(tree),
  );
  const descriptors = new Uint32Array(input.rows * 4);
  input.descriptors.forEach(({start, count, dataStart, limit}, row) =>
    descriptors.set([start, count, dataStart, limit], row * 4),
  );
  let end = Math.ceil(Number(kernel.__heap_base.value) / 16) * 16;
  const allocate = (bytes: number): number => {
    const at = end;
    end += Math.ceil(bytes / 16) * 16;
    return at;
  };
  const params = allocate(FIELDS * 4),
    frame = allocate(input.frame.length),
    surfaceAt = allocate(length),
    alphaAt = allocate(length),
    initializedAt = tracked ? allocate(length) : 0,
    alphaInitializedAt = tracked ? allocate(length) : 0,
    coefficients = allocate(coefficientCount * 2),
    defined = allocate(coefficientCount),
    descriptorsAt = allocate(descriptors.byteLength),
    treesAt = trees.map((tree) => (tree === null ? 0 : allocate(tree.byteLength))),
    quantization = allocate(128),
    colorTable = allocate(input.colorTable.byteLength),
    decoded = allocate(decodedLength);
  if (end > BF_WASM_MAX_WORKSPACE) {
    releaseInstance(kernel);
    return null;
  }
  const memory = kernel.memory;
  if (end > memory.buffer.byteLength) {
    try {
      memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536));
    } catch {
      releaseInstance(kernel);
      return null;
    }
  }
  const heap = new Uint8Array(memory.buffer);
  heap.set(input.frame, frame);
  heap.set(pixels, surfaceAt);
  if (tracked) heap.set(initialized, initializedAt);
  heap.set(new Uint8Array(descriptors.buffer), descriptorsAt);
  trees.forEach((tree, index) => {
    if (tree !== null) heap.set(new Uint8Array(tree.buffer), treesAt[index]!);
  });
  heap.set(input.quantization.subarray(0, 128), quantization);
  heap.set(new Uint8Array(input.colorTable.buffer, input.colorTable.byteOffset, 4096), colorTable);
  new Uint32Array(memory.buffer, params, FIELDS).set([
    frame,
    input.frame.length,
    input.width,
    input.height,
    input.depth,
    input.alphaMode,
    input.alphaStart,
    input.alphaBitsStart,
    surfaceAt,
    length,
    initializedAt,
    input.frameExtent,
    coefficients,
    defined,
    coefficientCount,
    descriptorsAt,
    input.rows,
    input.columns,
    input.alignedWidth,
    treesAt[0]!,
    treesAt[1]!,
    treesAt[2]!,
    quantization,
    colorTable,
    decoded,
    decodedLength,
  ]);
  if (kernel.bf_decode_alpha(params) !== 0) {
    releaseInstance(kernel);
    return null;
  }
  heap.copyWithin(alphaAt, surfaceAt, surfaceAt + length);
  if (tracked) heap.copyWithin(alphaInitializedAt, initializedAt, initializedAt + length);
  if (kernel.bf_decode_rows(params) !== 0) {
    releaseInstance(kernel);
    return null;
  }
  const band = input.width * 32;
  const publish = (
    surface: BurikoBfSurface,
    bytes: number,
    flags: number,
    from: number,
    to: number,
  ) => {
    surface.bytes.set(heap.subarray(bytes + from, bytes + to), from);
    if (tracked) surface.initialized.set(heap.subarray(flags + from, flags + to), from);
  };
  return {
    publishAlpha: (surface) => publish(surface, alphaAt, alphaInitializedAt, 0, length),
    publishRow: (surface, row) =>
      publish(
        surface,
        surfaceAt,
        initializedAt,
        row * band,
        Math.min(row * band + band, input.frameExtent),
      ),
    release: () => releaseInstance(kernel),
  };
}
