import {instantiateEmbeddedWasm} from '../../core/wasm.js';
import {reportWasmVideoFallback} from '../../platform/runtime-advisories.js';
import {
  Vc1Decoder as ReferenceDecoder,
  type Vc1Picture,
  type Vc1WasmBackend,
  VC1_PACKET_LIMIT,
} from './reference.js';
import {BITSTREAM_PADDING, type BitReader} from './bitstream.js';
import {VC1_VIDEO_WASM_BINARY} from './wasm-binary.js';

interface Kernel extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
  vc1_decode_blocks(state: number, data: number, index: number, size: number): number;
}
const MEMORY_LIMIT = 128 * 1024 * 1024;
const align = (n: number) => (n + 15) & ~15;
class AllocationFailure extends Error {}

/** Context and picture storage is reserved together before making views. The TS header
 * parser and Rust block loop share bitplanes, predictors and reference planes. Compressed
 * slice bytes are copied once; coefficient and pixel data never cross the ABI. */
class WasmKernel implements Vc1WasmBackend {
  private readonly base: number;
  private cursor = 0;
  private end = 0;
  private state!: Int32Array;
  private input!: Uint8Array;
  private lutY!: Uint8Array;
  private lutUv!: Uint8Array;
  constructor(private readonly kernel: Kernel) {
    this.base = align(Number(kernel.__heap_base.value));
  }
  reset(bytes: number): void {
    const end = align(this.base + bytes + VC1_PACKET_LIMIT + BITSTREAM_PADDING + 2048);
    if (end > MEMORY_LIMIT) throw new AllocationFailure();
    const memory = this.kernel.memory;
    if (end > memory.buffer.byteLength) {
      try {
        memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536));
      } catch {
        throw new AllocationFailure();
      }
    }
    this.cursor = this.base;
    this.end = end;
    this.state = this.i32(256);
    this.lutY = this.u8(256);
    this.lutUv = this.u8(256);
    this.input = this.u8(VC1_PACKET_LIMIT + BITSTREAM_PADDING);
    // Slice input, LUTs and state are overwritten before use. Only persistent context
    // and picture storage needs clearing when an arena is initialized or reused.
    new Uint8Array(memory.buffer, this.cursor, end - this.cursor).fill(0);
  }
  private allocate(bytes: number): number {
    const p = this.cursor;
    const end = align(p + bytes);
    if (end > this.end) throw new AllocationFailure();
    this.cursor = end;
    return p;
  }
  u8(length: number): Uint8Array {
    return new Uint8Array(this.kernel.memory.buffer, this.allocate(length), length);
  }
  decodeBlocks(state: Int32Array, bits: BitReader, lutY: Uint8Array, lutUv: Uint8Array): void {
    this.state.set(state);
    this.state[state.length - 2] = this.lutY.byteOffset;
    this.state[state.length - 1] = this.lutUv.byteOffset;
    this.lutY.set(lutY);
    this.lutUv.set(lutUv);
    this.input.set(bits.buffer.subarray(0, Math.ceil(bits.sizeInBits / 8) + BITSTREAM_PADDING));
    bits.index = this.kernel.vc1_decode_blocks(
      this.state.byteOffset,
      this.input.byteOffset,
      bits.index,
      bits.sizeInBits,
    );
  }
  i8(length: number): Int8Array {
    return new Int8Array(this.kernel.memory.buffer, this.allocate(length), length);
  }
  i32(length: number): Int32Array {
    return new Int32Array(this.kernel.memory.buffer, this.allocate(length * 4), length);
  }
  i16(length: number): Int16Array {
    return new Int16Array(this.kernel.memory.buffer, this.allocate(length * 2), length);
  }
}

/** Progressive decoder with Rust entropy decoding, prediction, transforms, motion
 * compensation and filtering. The shared TypeScript front end parses sequence/picture
 * headers and manages bounded reference storage; a slice crosses the ABI once. */
export class Vc1WasmDecoder {
  private constructor(private readonly decoder: ReferenceDecoder) {}
  static create(
    fourcc: number,
    width: number,
    height: number,
    extra: Uint8Array,
  ): Vc1WasmDecoder | null {
    const instance = instantiateEmbeddedWasm(VC1_VIDEO_WASM_BINARY, {}, reportWasmVideoFallback);
    if (!instance) return null;
    try {
      const backend = new WasmKernel(instance.exports as Kernel);
      return new Vc1WasmDecoder(new ReferenceDecoder(fourcc, width, height, extra, backend));
    } catch (error) {
      if (!(error instanceof AllocationFailure)) throw error;
      reportWasmVideoFallback();
      return null;
    }
  }
  get width(): number {
    return this.decoder.width;
  }
  get height(): number {
    return this.decoder.height;
  }
  decode(data: Uint8Array | null, time: number): Vc1Picture | null {
    return this.decoder.decode(data, time);
  }
}
