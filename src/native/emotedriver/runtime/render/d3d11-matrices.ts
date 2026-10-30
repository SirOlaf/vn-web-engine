import type {EmoteD3d11Matrix} from '../../contract.js';

const f = Math.fround;

/**
 * Native device matrices, exact x64 DLL 80d28bd0…1e051. The automatic camera
 * (0x18005fa00) uses scalar multiply/add stores; the manual path (0x180061450)
 * sums the first/third and second/fourth products in SSE pairs. Shader upload
 * (0x180062390) transposes
 * only the manual result. Neither path uses the x86 D3DX arithmetic.
 */
export class EmoteD3d11Matrices {
  private readonly world = new Float32Array(16);
  private readonly view = new Float32Array(16);
  private readonly projection = new Float32Array(16);
  private readonly intermediate = new Float32Array(16);
  private readonly combined = new Float32Array(16);
  private readonly uploaded = new Float32Array(16);
  private readonly combinedWords = new Uint32Array(this.combined.buffer);
  private readonly uploadedWords = new Uint32Array(this.uploaded.buffer);
  private automatic = true;

  constructor() {
    // 0x18005f0e0: world/view/projection identity, automatic camera enabled.
    for (const matrix of [this.world, this.view, this.projection])
      for (let i = 0; i < 16; i += 5) matrix[i] = 1;
  }

  /** 0x180001b10; changing a matrix alone does not disable the automatic camera. */
  setAutomaticMatrix(enabled: boolean): void {
    this.automatic = enabled;
  }

  /** 0x180001b20. */
  getAutomaticMatrix(): boolean {
    return this.automatic;
  }

  /** 0x180001b70; copy immediately, retaining no caller storage. */
  setWorldMatrix(matrix: EmoteD3d11Matrix): void {
    this.copy(this.world, matrix);
  }

  /** 0x180001ba0. */
  setViewMatrix(matrix: EmoteD3d11Matrix): void {
    this.copy(this.view, matrix);
  }

  /** 0x180001be0. */
  setProjectionMatrix(matrix: EmoteD3d11Matrix): void {
    this.copy(this.projection, matrix);
  }

  /**
   * Borrowed VS1 constant words, valid until the next preparation. Width/height
   * are the external target's base resource dimensions. Screen mode0 chooses
   * the upward camera; every other mode chooses the downward camera. Screen
   * rectangle placement belongs to the viewport, not the automatic projection.
   */
  shaderMatrix(width: number, height: number, mode: number): Float32Array {
    if (this.automatic) {
      this.camera(width, height, mode);
      // Automatic matrices are already in the shader's register layout.
      this.multiply(this.projection, this.view, this.uploaded, false);
    } else {
      this.multiply(this.world, this.view, this.intermediate, true);
      this.multiply(this.intermediate, this.projection, this.combined, true);
      for (let row = 0; row < 4; row++)
        for (let column = 0; column < 4; column++)
          this.uploadedWords[row * 4 + column] = this.combinedWords[column * 4 + row]!;
    }
    return this.uploaded;
  }

  private copy(target: Float32Array, source: EmoteD3d11Matrix): void {
    if (source.length !== 16) throw new RangeError('Invalid E-mote matrix');
    target.set(source);
  }

  private camera(width: number, height: number, mode: number): void {
    const halfWidth = f(f(width >>> 0) * 0.5),
      halfHeight = f(f(height >>> 0) * 0.5),
      rangeX = f(halfWidth - -halfWidth),
      rangeY = f(halfHeight - -halfHeight),
      direction = (mode | 0) === 0 ? 1 : -1;
    // 0x180061450 calls 0x18005fa00 with eye.x/y=0 and camera scale1.
    // The normalized basis is exact; keep the native negative translation zeros.
    this.view.fill(0);
    this.view[0] = this.view[15] = 1;
    this.view[5] = this.view[10] = direction;
    this.view[3] = this.view[7] = -0;
    this.view[11] = -1;
    this.projection.fill(0);
    this.projection[0] = f(2 / rangeX);
    this.projection[5] = f(2 / rangeY);
    this.projection[3] = f(-f(halfWidth + -halfWidth) / rangeX);
    this.projection[7] = f(-f(halfHeight + -halfHeight) / rangeY);
    this.projection[10] = f(-0.1);
    this.projection[11] = -1;
    this.projection[15] = 1;
  }

  private multiply(a: Float32Array, b: Float32Array, out: Float32Array, pairs: boolean): void {
    for (let row = 0; row < 4; row++)
      for (let column = 0; column < 4; column++) {
        const x = f(a[row * 4]! * b[column]!),
          y = f(a[row * 4 + 1]! * b[4 + column]!),
          z = f(a[row * 4 + 2]! * b[8 + column]!),
          w = f(a[row * 4 + 3]! * b[12 + column]!);
        out[row * 4 + column] = pairs ? f(f(x + z) + f(y + w)) : f(f(f(y + x) + z) + w);
      }
  }
}
