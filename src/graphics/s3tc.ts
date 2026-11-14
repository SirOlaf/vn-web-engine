import {instantiateEmbeddedWasm} from '../core/wasm.js';
import {S3TC_WASM_BINARY} from './s3tc-wasm-binary.js';

/**
 * DXT5 (BC3) textures: a WebGL upload path that keeps blocks compressed when
 * `WEBGL_compressed_texture_s3tc` is present, and an RGBA8 decoder (Rust/Wasm in `wasm/s3tc`,
 * JavaScript when WebAssembly is unavailable) otherwise. This mirrors how a Direct3D 9 title
 * creates a `D3DFMT_DXT5` texture when `CheckDeviceFormat` accepts it and converts on the CPU
 * when it does not.
 *
 * Block layout (16 bytes, little-endian, texels row-major within a 4x4 block):
 * - bytes 0-1: alpha endpoints `a0`, `a1`; bytes 2-7: sixteen 3-bit alpha indices.
 *   `a0 > a1`: eight alphas, `a[i + 1] = (a0 * (7 - i) + a1 * i) / 7` for i = 1..6.
 *   `a0 <= a1`: six alphas, `a[i + 1] = (a0 * (5 - i) + a1 * i) / 5` for i = 1..4, then 0, 255.
 * - bytes 8-11: RGB565 `color0`, `color1`, widened by bit replication; bytes 12-15: sixteen
 *   2-bit color indices. Index 2 is `(2 * c0 + c1) / 3` and index 3 `(c0 + 2 * c1) / 3`.
 * All divisions truncate, as in emotedriver's converter.
 *
 * `color0 <= color1`: Direct3D 9 defines DXT2-5 color blocks as always four-color (the DXT1
 * three-color/transparent layout does not apply), and `EXT_texture_compression_s3tc` states
 * the same for DXT3/DXT5. That is `DXT5_FOUR_COLOR`, what the compressed upload path yields.
 * emotedriver.dll's own CPU converter (0x10053fb0, color 0x100532b0, alpha 0x10053750)
 * instead switches such blocks to three-color: index 2 is `(c0 + c1) / 2` and index 3 keeps
 * the same RGB (its alpha comes from the alpha block). That is `DXT5_EMOTEDRIVER`. Callers
 * mirroring a native software path select it; the decoder does not choose by caller.
 * Hardware interpolation precision is implementation-defined within Direct3D's tolerance, so
 * a decoded texture can differ from a compressed upload by rounding in indices 2 and 3.
 */

export const COMPRESSED_RGBA_S3TC_DXT5_EXT = 0x83f3;
/** Color indices 2 and 3 always interpolate (Direct3D 9 / OpenGL DXT2-5 semantics). */
export const DXT5_FOUR_COLOR = 0;
/** emotedriver's software converter: `color0 <= color1` blocks use the three-color layout. */
export const DXT5_EMOTEDRIVER = 1;
export type Dxt5ColorMode = typeof DXT5_FOUR_COLOR | typeof DXT5_EMOTEDRIVER;

/** Byte length of a DXT5 surface. */
export function dxt5ByteLength(width: number, height: number): number {
  return Math.ceil(width / 4) * Math.ceil(height / 4) * 16;
}

/** The S3TC extension, or null when the context cannot sample DXT5 natively. */
export function s3tcExtension(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
): WEBGL_compressed_texture_s3tc | null {
  return (
    gl.getExtension('WEBGL_compressed_texture_s3tc') ??
    (gl.getExtension(
      'WEBKIT_WEBGL_compressed_texture_s3tc',
    ) as WEBGL_compressed_texture_s3tc | null)
  );
}

interface S3tcExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
  dxt5_decode: (
    source: number,
    width: number,
    height: number,
    destination: number,
    mode: number,
  ) => void;
}

const MAX_WASM_BYTES = 256 * 1024 * 1024;

function validate(blocks: Uint8Array, width: number, height: number): void {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0)
    throw new RangeError(`Invalid DXT5 size ${width}x${height}`);
  if (blocks.length < dxt5ByteLength(width, height))
    throw new RangeError(`DXT5 ${width}x${height} needs ${dxt5ByteLength(width, height)} bytes`);
}

/** DXT5 to tightly packed RGBA8 (bytes R, G, B, A). Uses Wasm when it instantiates. */
export class Dxt5Decoder {
  private kernel: S3tcExports | null | undefined;

  /** `wasm: false` keeps the JavaScript decoder (no instantiation). */
  constructor(options: {readonly wasm?: boolean} = {}) {
    if (options.wasm === false) this.kernel = null;
  }

  /** True when the Wasm kernel is in use; false selects the JavaScript decoder. */
  get accelerated(): boolean {
    return this.wasm() !== null;
  }

  decode(
    blocks: Uint8Array,
    width: number,
    height: number,
    mode: Dxt5ColorMode = DXT5_FOUR_COLOR,
    output = new Uint8Array(width * height * 4),
  ): Uint8Array {
    validate(blocks, width, height);
    if (output.length < width * height * 4) throw new RangeError('DXT5 output is too small');
    if (!this.decodeWasm(blocks, width, height, mode, output))
      decodeDxt5Js(blocks, width, height, mode, output);
    return output;
  }

  private wasm(): S3tcExports | null {
    if (this.kernel === undefined) {
      const instance = instantiateEmbeddedWasm(S3TC_WASM_BINARY);
      this.kernel = instance === null ? null : (instance.exports as S3tcExports);
    }
    return this.kernel;
  }

  private decodeWasm(
    blocks: Uint8Array,
    width: number,
    height: number,
    mode: Dxt5ColorMode,
    output: Uint8Array,
  ): boolean {
    const kernel = this.wasm();
    if (kernel === null) return false;
    const inputLength = dxt5ByteLength(width, height),
      outputLength = width * height * 4,
      input = Math.ceil(Number(kernel.__heap_base.value) / 16) * 16,
      destination = input + Math.ceil(inputLength / 16) * 16,
      end = destination + outputLength;
    if (end > MAX_WASM_BYTES) return false;
    const memory = kernel.memory;
    if (end > memory.buffer.byteLength) {
      try {
        memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536));
      } catch {
        return false;
      }
    }
    new Uint8Array(memory.buffer, input, inputLength).set(blocks.subarray(0, inputLength));
    kernel.dxt5_decode(input, width, height, destination, mode);
    output.set(new Uint8Array(memory.buffer, destination, outputLength));
    return true;
  }
}

/** JavaScript twin of `wasm/s3tc`, used when WebAssembly is unavailable. */
function decodeDxt5Js(
  blocks: Uint8Array,
  width: number,
  height: number,
  mode: Dxt5ColorMode,
  output: Uint8Array,
): void {
  const alpha = new Uint8Array(8),
    colors = new Uint8Array(16),
    blocksX = Math.ceil(width / 4),
    blocksY = Math.ceil(height / 4);
  let offset = 0;
  for (let by = 0; by < blocksY; by++)
    for (let bx = 0; bx < blocksX; bx++, offset += 16) {
      const a0 = blocks[offset]!,
        a1 = blocks[offset + 1]!;
      alpha[0] = a0;
      alpha[1] = a1;
      if (a0 > a1) for (let i = 1; i < 7; i++) alpha[i + 1] = ((a0 * (7 - i) + a1 * i) / 7) | 0;
      else {
        for (let i = 1; i < 5; i++) alpha[i + 1] = ((a0 * (5 - i) + a1 * i) / 5) | 0;
        alpha[6] = 0;
        alpha[7] = 255;
      }
      const raw0 = blocks[offset + 8]! | (blocks[offset + 9]! << 8),
        raw1 = blocks[offset + 10]! | (blocks[offset + 11]! << 8);
      expand565(raw0, colors, 0);
      expand565(raw1, colors, 4);
      const threeColor = mode === DXT5_EMOTEDRIVER && raw0 <= raw1;
      for (let c = 0; c < 3; c++) {
        const c0 = colors[c]!,
          c1 = colors[4 + c]!;
        if (threeColor) colors[8 + c] = colors[12 + c] = ((c0 + c1) / 2) | 0;
        else {
          colors[8 + c] = ((2 * c0 + c1) / 3) | 0;
          colors[12 + c] = ((c0 + 2 * c1) / 3) | 0;
        }
      }
      // Six alpha index bytes as two 24-bit halves (eight texels each).
      const alphaLow =
          blocks[offset + 2]! | (blocks[offset + 3]! << 8) | (blocks[offset + 4]! << 16),
        alphaHigh = blocks[offset + 5]! | (blocks[offset + 6]! << 8) | (blocks[offset + 7]! << 16),
        indices =
          (blocks[offset + 12]! |
            (blocks[offset + 13]! << 8) |
            (blocks[offset + 14]! << 16) |
            (blocks[offset + 15]! << 24)) >>>
          0;
      for (let texel = 0; texel < 16; texel++) {
        const x = bx * 4 + (texel & 3),
          y = by * 4 + (texel >> 2);
        if (x >= width || y >= height) continue;
        const target = (y * width + x) * 4,
          color = ((indices >>> (2 * texel)) & 3) * 4,
          a = texel < 8 ? (alphaLow >> (3 * texel)) & 7 : (alphaHigh >> (3 * (texel - 8))) & 7;
        output[target] = colors[color]!;
        output[target + 1] = colors[color + 1]!;
        output[target + 2] = colors[color + 2]!;
        output[target + 3] = alpha[a]!;
      }
    }
}

function expand565(color: number, out: Uint8Array, offset: number): void {
  const r = color >> 11,
    g = (color >> 5) & 63,
    b = color & 31;
  out[offset] = (r << 3) | (r >> 2);
  out[offset + 1] = (g << 2) | (g >> 4);
  out[offset + 2] = (b << 3) | (b >> 2);
}

let sharedDecoder: Dxt5Decoder | undefined;

/**
 * Uploads one DXT5 mip level to the bound texture of `target`. Compressed when the context
 * has S3TC, otherwise decoded to RGBA8 with `fallbackMode`. Returns which path was taken.
 */
export function uploadDxt5Level(
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  target: number,
  level: number,
  width: number,
  height: number,
  blocks: Uint8Array,
  fallbackMode: Dxt5ColorMode = DXT5_FOUR_COLOR,
): 'compressed' | 'decoded' {
  validate(blocks, width, height);
  if (s3tcExtension(gl) !== null) {
    gl.compressedTexImage2D(
      target,
      level,
      COMPRESSED_RGBA_S3TC_DXT5_EXT,
      width,
      height,
      0,
      blocks.subarray(0, dxt5ByteLength(width, height)),
    );
    return 'compressed';
  }
  const rgba = (sharedDecoder ??= new Dxt5Decoder()).decode(blocks, width, height, fallbackMode);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texImage2D(target, level, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  return 'decoded';
}
