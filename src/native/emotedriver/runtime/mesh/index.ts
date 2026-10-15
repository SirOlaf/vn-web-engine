import {instantiateEmbeddedWasm} from '../../../../core/wasm.js';
import type {EmoteMeshKernel} from '../interfaces.js';
import {emoteMeshKernelJs} from './kernel.js';
import {EMOTE_MESH_WASM_BINARY} from './wasm-binary.js';

export {bernsteinTable, emoteMeshKernelJs} from './kernel.js';

/**
 * Mesh kernel (0x1002cd90, 0x1002d960, 0x1003f680): Rust/Wasm crate `wasm/emote-mesh`, with
 * the TypeScript twin in `kernel.ts` when WebAssembly is unavailable. Both give identical
 * bits; `tests/emotedriver-clip.test.mjs` checks this on synthetic patches.
 */
interface EmoteMeshExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
  evaluate_patch(cp: number, columns: number, rows: number, scratch: number, out: number): void;
  deform_points(
    cp: number,
    inverse: number,
    translateX: number,
    translateY: number,
    points: number,
    count: number,
  ): void;
  subdivide_quad(corners: number, columns: number, rows: number, out: number): void;
}

class WasmMeshKernel implements EmoteMeshKernel {
  private readonly base: number;
  constructor(private readonly exports: EmoteMeshExports) {
    this.base = Math.ceil(Number(exports.__heap_base.value) / 16) * 16;
  }

  /** Grows memory so `bytes` bytes after the heap base are addressable. */
  private reserve(bytes: number): void {
    const end = this.base + bytes,
      memory = this.exports.memory;
    if (end > memory.buffer.byteLength)
      memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536));
  }

  private heap(): Float32Array {
    return new Float32Array(this.exports.memory.buffer);
  }

  evaluatePatch(controlPoints: Float32Array, columns: number, rows: number, out: Float32Array) {
    const scratch = (columns + rows + 2) * 4,
      points = (columns + 1) * (rows + 1) * 2;
    this.reserve(0x80 + (scratch + points) * 4);
    const heap = this.heap(),
      cp = this.base,
      scratchAt = cp + 0x80,
      outAt = scratchAt + scratch * 4;
    heap.set(controlPoints.subarray(0, 32), cp >> 2);
    this.exports.evaluate_patch(cp, columns, rows, scratchAt, outAt);
    out.set(this.heap().subarray(outAt >> 2, (outAt >> 2) + points));
  }

  deformPoints(
    controlPoints: Float32Array,
    inverse: Float32Array,
    translateX: number,
    translateY: number,
    points: Float32Array,
    count: number,
  ) {
    this.reserve(0x90 + count * 8);
    const heap = this.heap(),
      cp = this.base,
      inv = cp + 0x80,
      at = inv + 0x10;
    heap.set(controlPoints.subarray(0, 32), cp >> 2);
    heap.set(inverse.subarray(0, 4), inv >> 2);
    heap.set(points.subarray(0, count * 2), at >> 2);
    this.exports.deform_points(cp, inv, translateX, translateY, at, count);
    points.set(this.heap().subarray(at >> 2, (at >> 2) + count * 2));
  }

  subdivideQuad(corners: Float32Array, columns: number, rows: number, out: Float32Array) {
    const points = (columns + 1) * (rows + 1) * 2;
    this.reserve(0x20 + points * 4);
    const heap = this.heap(),
      at = this.base,
      outAt = at + 0x20;
    heap.set(corners.subarray(0, 8), at >> 2);
    this.exports.subdivide_quad(at, columns, rows, outAt);
    out.set(this.heap().subarray(outAt >> 2, (outAt >> 2) + points));
  }
}

let shared: EmoteMeshKernel | undefined;

/** The Wasm kernel when it instantiates, else the TypeScript twin. `wasm: false` forces the twin. */
export function createEmoteMeshKernel(options: {readonly wasm?: boolean} = {}): EmoteMeshKernel {
  if (options.wasm === false) return emoteMeshKernelJs;
  if (shared === undefined) {
    const instance = instantiateEmbeddedWasm(EMOTE_MESH_WASM_BINARY);
    shared =
      instance === null
        ? emoteMeshKernelJs
        : new WasmMeshKernel(instance.exports as EmoteMeshExports);
  }
  return shared;
}
