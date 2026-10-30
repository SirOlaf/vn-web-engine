import type {EmoteX64MeshKernel} from '../interfaces.js';

/** X64 0x18002df10: float32 grid coordinates and weights, with double products. */
export function bernsteinTableX64(segments: number): Float32Array {
  const out = new Float32Array((segments + 1) * 4);
  for (let i = 0; i <= segments; i++) {
    const t = Math.fround(i / segments),
      s = Math.fround(1 - t);
    out[i * 4] = s * s * s;
    out[i * 4 + 1] = 3 * s * s * t;
    out[i * 4 + 2] = 3 * s * t * t;
    out[i * 4 + 3] = t * t * t;
  }
  return out;
}

function weights(t: number, out: Float64Array, at: number): void {
  const s = 1 - t;
  out[at] = s * s * s;
  out[at + 1] = 3 * s * s * t;
  out[at + 2] = 3 * s * t * t;
  out[at + 3] = t * t * t;
}

class X64MeshKernelJs implements EmoteX64MeshKernel {
  readonly accelerated = false;
  private readonly worldX = new Float64Array(16);
  private readonly worldY = new Float64Array(16);
  private readonly weightsU = new Float64Array(4);
  private readonly weightsV = new Float64Array(4);
  private readonly tables = new Map<number, Float32Array>();

  private basis(segments: number): Float32Array {
    const cached = this.tables.get(segments);
    if (cached) {
      this.tables.delete(segments);
      this.tables.set(segments, cached);
      return cached;
    }
    const table = bernsteinTableX64(segments);
    // Keep small recurring grids; large one-off calls cannot grow the cache.
    if (segments <= 1024) {
      if (this.tables.size === 16) this.tables.delete(this.tables.keys().next().value!);
      this.tables.set(segments, table);
    }
    return table;
  }

  evaluatePatch(patch: Float32Array, columns: number, rows: number, out: Float32Array): void {
    for (let i = 0; i < 16; i++) {
      this.worldX[i] = patch[i * 2]!;
      this.worldY[i] = patch[i * 2 + 1]!;
    }
    this.grid(columns, rows, out);
  }

  private grid(columns: number, rows: number, out: Float32Array): void {
    const u = this.basis(columns),
      v = this.basis(rows),
      px = this.worldX,
      py = this.worldY;
    let at = 0;
    for (let j = 0; j <= rows; j++)
      for (let i = 0; i <= columns; i++) {
        let x = 0,
          y = 0;
        for (let r = 0; r < 4; r++)
          for (let c = 0; c < 4; c++) {
            const w = u[i * 4 + c]! * v[j * 4 + r]!;
            x += px[r * 4 + c]! * w;
            y += py[r * 4 + c]! * w;
          }
        out[at++] = x;
        out[at++] = y;
      }
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
    const m0 = matrix[0]!,
      m1 = matrix[1]!,
      m2 = matrix[2]!,
      m3 = matrix[3]!;
    for (let i = 0; i < 16; i++) {
      const px = patch[i * 2]!,
        py = patch[i * 2 + 1]!;
      this.worldX[i] = Math.fround(m0 * px + m1 * py + x);
      this.worldY[i] = Math.fround(m2 * px + m3 * py + y);
    }
    this.grid(columns, rows, out);
  }

  mapPatchPoints(points: Float32Array, count: number, patch: Float32Array, offset = 0): void {
    const u = this.weightsU,
      v = this.weightsV;
    for (let k = 0; k < count; k++) {
      const at = offset + k * 2;
      weights(points[at]!, u, 0);
      weights(points[at + 1]!, v, 0);
      let x = 0,
        y = 0;
      for (let r = 0; r < 4; r++)
        for (let c = 0; c < 4; c++) {
          const w = u[c]! * v[r]!;
          x += patch[(r * 4 + c) * 2]! * w;
          y += patch[(r * 4 + c) * 2 + 1]! * w;
        }
      points[at] = x;
      points[at + 1] = y;
    }
  }

  affinePoints(
    points: Float32Array,
    count: number,
    matrix: ArrayLike<number>,
    x: number,
    y: number,
  ): void {
    for (let k = 0; k < count; k++) {
      const px = points[k * 2]! + x,
        py = points[k * 2 + 1]! + y;
      points[k * 2] = matrix[0]! * px + matrix[1]! * py;
      points[k * 2 + 1] = matrix[2]! * px + matrix[3]! * py;
    }
  }

  deformPoints(
    patch: Float32Array,
    inverse: Float32Array,
    x: number,
    y: number,
    points: Float32Array,
    count: number,
  ): void {
    this.affinePoints(points, count, inverse, x, y);
    this.mapPatchPoints(points, count, patch);
  }

  subdivideQuad(corners: Float32Array, columns: number, rows: number, out: Float32Array): void {
    const dv = Math.fround(1 / rows),
      du = Math.fround(1 / columns);
    let at = 0;
    for (let j = 0; j <= rows; j++) {
      const v = Math.fround(j * dv),
        iv = Math.fround(1 - v);
      for (let i = 0; i <= columns; i++) {
        const u = Math.fround(i * du),
          iu = Math.fround(1 - u);
        out[at++] =
          iu * (v * corners[4]! + corners[0]! * iv) + u * (corners[2]! * iv + corners[6]! * v);
        out[at++] =
          (corners[1]! * iv + v * corners[5]!) * iu + (corners[3]! * iv + v * corners[7]!) * u;
      }
    }
  }
}

/** TypeScript twin of the exact x64 kernel; all scratch and table caches are bounded. */
export const emoteMeshKernelX64Js: EmoteX64MeshKernel = new X64MeshKernelJs();
