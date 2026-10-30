import {instantiateEmbeddedWasm} from '../../../../core/wasm.js';
import type {EmoteMeshKernel, EmoteX64MeshKernel} from '../interfaces.js';
import {emoteBuild, EMOTEDRIVER_X64_SHA256} from '../../build.js';
import {emoteMeshKernelX64Js} from './x64.js';
import {emoteMeshKernelJs} from './kernel.js';
import {EMOTE_MESH_WASM_BINARY} from './wasm-binary.js';

export {bernsteinTable, emoteMeshKernelJs} from './kernel.js';
export {bernsteinTableX64} from './x64.js';

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
  evaluate_patch_x64(cp: number, columns: number, rows: number, scratch: number, out: number): void;
  evaluate_transformed_patch_x64(
    cp: number,
    columns: number,
    rows: number,
    matrix: number,
    x: number,
    y: number,
    scratch: number,
    out: number,
  ): void;
  map_patch_points_x64(cp: number, points: number, count: number): void;
  affine_points_x64(matrix: number, x: number, y: number, points: number, count: number): void;
  deform_points_x64(
    cp: number,
    inverse: number,
    x: number,
    y: number,
    points: number,
    count: number,
  ): void;
  subdivide_quad_x64(corners: number, columns: number, rows: number, out: number): void;
}

class WasmMeshKernel implements EmoteX64MeshKernel {
  readonly accelerated = true;
  private readonly base: number;
  constructor(
    private readonly exports: EmoteMeshExports,
    private readonly x64: boolean,
  ) {
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
    (this.x64 ? this.exports.evaluate_patch_x64 : this.exports.evaluate_patch)(
      cp,
      columns,
      rows,
      scratchAt,
      outAt,
    );
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
    (this.x64 ? this.exports.deform_points_x64 : this.exports.deform_points)(
      cp,
      inv,
      translateX,
      translateY,
      at,
      count,
    );
    points.set(this.heap().subarray(at >> 2, (at >> 2) + count * 2));
  }

  subdivideQuad(corners: Float32Array, columns: number, rows: number, out: Float32Array) {
    const points = (columns + 1) * (rows + 1) * 2;
    this.reserve(0x20 + points * 4);
    const heap = this.heap(),
      at = this.base,
      outAt = at + 0x20;
    heap.set(corners.subarray(0, 8), at >> 2);
    (this.x64 ? this.exports.subdivide_quad_x64 : this.exports.subdivide_quad)(
      at,
      columns,
      rows,
      outAt,
    );
    out.set(this.heap().subarray(outAt >> 2, (outAt >> 2) + points));
  }

  private requireX64(): void {
    if (!this.x64) throw new Error('x64 mesh operation requires the x64 DLL image');
  }

  mapPatchPoints(points: Float32Array, count: number, patch: Float32Array, offset = 0): void {
    this.requireX64();
    // Avoid a heap copy and host transition for the short anchor/sync queries.
    if (count < 16) {
      emoteMeshKernelX64Js.mapPatchPoints(points, count, patch, offset);
      return;
    }
    this.reserve(0x80 + count * 8);
    const heap = this.heap(),
      cp = this.base,
      at = cp + 0x80;
    heap.set(patch.subarray(0, 32), cp >> 2);
    heap.set(points.subarray(offset, offset + count * 2), at >> 2);
    this.exports.map_patch_points_x64(cp, at, count);
    points.set(this.heap().subarray(at >> 2, (at >> 2) + count * 2), offset);
  }

  affinePoints(
    points: Float32Array,
    count: number,
    matrix: ArrayLike<number>,
    x: number,
    y: number,
  ): void {
    this.requireX64();
    this.reserve(0x20 + count * 8);
    const m = this.base,
      at = m + 0x20;
    const doubles = new Float64Array(this.exports.memory.buffer);
    for (let i = 0; i < 4; i++) doubles[(m >> 3) + i] = matrix[i]!;
    this.heap().set(points.subarray(0, count * 2), at >> 2);
    this.exports.affine_points_x64(m, x, y, at, count);
    points.set(this.heap().subarray(at >> 2, (at >> 2) + count * 2));
  }

  evaluateTransformedPatch(
    patch: Float32Array,
    columns: number,
    rows: number,
    matrix: ArrayLike<number>,
    x: number,
    y: number,
    out: Float32Array,
  ): void {
    this.requireX64();
    const scratch = (columns + rows + 2) * 4,
      points = (columns + 1) * (rows + 1) * 2;
    this.reserve(0xa0 + (scratch + points) * 4);
    const cp = this.base,
      m = cp + 0x80,
      scratchAt = m + 0x20,
      outAt = scratchAt + scratch * 4;
    this.heap().set(patch.subarray(0, 32), cp >> 2);
    const doubles = new Float64Array(this.exports.memory.buffer);
    for (let i = 0; i < 4; i++) doubles[(m >> 3) + i] = matrix[i]!;
    this.exports.evaluate_transformed_patch_x64(cp, columns, rows, m, x, y, scratchAt, outAt);
    out.set(this.heap().subarray(outAt >> 2, (outAt >> 2) + points));
  }
}

const shared = new Map<string, EmoteMeshKernel>();

export interface EmoteMeshKernelOptions {
  readonly wasm?: boolean;
  /** Exact driver image; omission retains the x86 kernel. */
  readonly driverSha256?: string;
}
export function createEmoteMeshKernel(
  options: EmoteMeshKernelOptions & {
    readonly driverSha256: typeof EMOTEDRIVER_X64_SHA256;
  },
): EmoteX64MeshKernel;
export function createEmoteMeshKernel(options?: EmoteMeshKernelOptions): EmoteMeshKernel;
/** Select once per exact image; the TypeScript twin covers hosts without WebAssembly SIMD. */
export function createEmoteMeshKernel(options: EmoteMeshKernelOptions = {}): EmoteMeshKernel {
  const sha = emoteBuild(options.driverSha256),
    x64 = sha === EMOTEDRIVER_X64_SHA256;
  const reference = x64 ? emoteMeshKernelX64Js : emoteMeshKernelJs;
  if (options.wasm === false) return reference;
  let kernel = shared.get(sha);
  if (kernel === undefined) {
    const instance = instantiateEmbeddedWasm(EMOTE_MESH_WASM_BINARY);
    kernel =
      instance === null ? reference : new WasmMeshKernel(instance.exports as EmoteMeshExports, x64);
    shared.set(sha, kernel);
  }
  return kernel;
}
