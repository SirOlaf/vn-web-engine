import {instantiateEmbeddedWasm} from '../../core/wasm.js';
import {reportWasmGraphicsFallback} from '../../platform/runtime-advisories.js';
import type {Outline} from './outline.js';
import {embolden, GrayRaster, type OutlineRasterizer} from './raster.js';
import {OUTLINE_RASTER_WASM_BINARY} from './raster-wasm-binary.js';
import {FontError} from './sfnt.js';

interface OutlineRasterExports extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
  outline_render: (...args: number[]) => number;
  outline_embolden: (...args: number[]) => void;
}

/** Largest Wasm heap a glyph may use; bigger glyphs render in JavaScript. */
const MEMORY_LIMIT = 64 * 1024 * 1024;

const align = (offset: number) => (offset + 15) & ~15;

let shared: OutlineRasterWasm | null | undefined;

/** `wasm/outline-raster`: the raster and embolden of `raster.ts` in WebAssembly with SIMD. The
 * outline is copied into the module's private memory, rendered and copied back out.
 */
export class OutlineRasterWasm implements OutlineRasterizer {
  private readonly heapBase: number;
  private bytes: Uint8Array;
  private words: Int32Array;
  private fallback: GrayRaster | null = null;

  private constructor(private readonly kernel: OutlineRasterExports) {
    this.heapBase = align(Number(kernel.__heap_base.value));
    this.bytes = new Uint8Array(kernel.memory.buffer);
    this.words = new Int32Array(kernel.memory.buffer);
  }

  /** The thread's shared instance, or null when WebAssembly SIMD is unavailable. */
  static create(): OutlineRasterWasm | null {
    if (shared === undefined) {
      const instance = instantiateEmbeddedWasm(OUTLINE_RASTER_WASM_BINARY);
      shared =
        instance === null ? null : new OutlineRasterWasm(instance.exports as OutlineRasterExports);
    }
    return shared;
  }

  render(outline: Outline, width: number, height: number, xstr: number, ystr: number): Uint8Array {
    const n = outline.nPoints,
      c = outline.nContours,
      size = width * height,
      bold = (xstr || ystr) && size,
      pitch = width + xstr,
      boldSize = bold ? pitch * (height + ystr) : 0;
    const points = this.heapBase,
      contours = align(points + n * 8),
      tags = align(contours + c * 2),
      cells = align(tags + n),
      pixels = align(cells + 8 * (width + 1) * height),
      scratch = align(pixels + size),
      boldPixels = align(scratch + (bold ? width + 2 * xstr + 16 : 0)),
      end = boldPixels + boldSize;
    if (end > MEMORY_LIMIT || !this.reserve(end))
      return this.renderFallback(outline, width, height, xstr, ystr);
    const words = this.words,
      bytes = this.bytes;
    words.set(outline.points.subarray(0, n * 2), points >> 2);
    new Int16Array(bytes.buffer, contours, c).set(outline.contours.subarray(0, c));
    bytes.set(outline.tags.subarray(0, n), tags);
    const error = this.kernel.outline_render(
      points,
      tags,
      contours,
      n,
      c,
      width,
      height,
      pixels,
      cells,
    );
    if (error) throw new FontError(error);
    if (!bold) return bytes.slice(pixels, pixels + size);
    this.kernel.outline_embolden(pixels, width, height, xstr, ystr, boldPixels, scratch);
    return bytes.slice(boldPixels, boldPixels + boldSize);
  }

  private reserve(end: number): boolean {
    const memory = this.kernel.memory;
    if (end > memory.buffer.byteLength) {
      try {
        memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536));
      } catch {
        reportWasmGraphicsFallback();
        return false;
      }
      this.bytes = new Uint8Array(memory.buffer);
      this.words = new Int32Array(memory.buffer);
    }
    return true;
  }

  private renderFallback(
    outline: Outline,
    width: number,
    height: number,
    xstr: number,
    ystr: number,
  ): Uint8Array {
    const pixels = new Uint8Array(width * height);
    (this.fallback ??= new GrayRaster()).render(outline, width, height, pixels);
    return (xstr || ystr) && pixels.length ? embolden(pixels, width, height, xstr, ystr) : pixels;
  }
}
