import {instantiateEmbeddedWasm} from '../../core/wasm.js';
import {reportWasmVideoFallback} from '../../platform/runtime-advisories.js';
import type {BitReader} from '../vc1/bitstream.js';
import {WmaLosslessDecoder, type LosslessBackend, type LosslessConfig} from './lossless.js';
import {WmaStandardDecoder, type StandardBackend, type StandardConfig} from './standard.js';
import {WmaProDecoder, type ProBackend, type ProConfig} from './pro.js';
import {WMA_AUDIO_WASM_BINARY} from './wasm-binary.js';

interface Kernel extends WebAssembly.Exports {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
  wma_lossless_channel(state: number, data: number, index: number, size: number): number;
  wma_lossless_finish(state: number): void;
  wma_standard_frame(state: number, input: number, index: number, size: number): number;
  wma_pro_frame(state: number, input: number, index: number, size: number): number;
}

/** A fixed arena is grown before any views are created. Instances do not share state. */
class Backend implements LosslessBackend, StandardBackend, ProBackend {
  private cursor: number;
  private readonly end: number;
  constructor(private readonly kernel: Kernel) {
    this.cursor = (Number(kernel.__heap_base.value) + 15) & ~15;
    this.end = this.cursor + 512 * 1024;
    if (this.end > kernel.memory.buffer.byteLength)
      kernel.memory.grow(Math.ceil((this.end - kernel.memory.buffer.byteLength) / 65536));
  }
  private allocate(bytes: number): number {
    const p = this.cursor;
    this.cursor = (p + bytes + 15) & ~15;
    if (this.cursor > this.end) throw Error('WMA audio arena exhausted');
    return p;
  }
  u8(n: number): Uint8Array {
    return new Uint8Array(this.kernel.memory.buffer, this.allocate(n), n);
  }
  i16(n: number): Int16Array {
    return new Int16Array(this.kernel.memory.buffer, this.allocate(n * 2), n);
  }
  u16(n: number): Uint16Array {
    return new Uint16Array(this.kernel.memory.buffer, this.allocate(n * 2), n);
  }
  f32(n: number): Float32Array {
    return new Float32Array(this.kernel.memory.buffer, this.allocate(n * 4), n);
  }
  f64(n: number): Float64Array {
    return new Float64Array(this.kernel.memory.buffer, this.allocate(n * 8), n);
  }
  i32(n: number): Int32Array {
    return new Int32Array(this.kernel.memory.buffer, this.allocate(n * 4), n);
  }
  decodeChannel(state: Int32Array, reader: BitReader): void {
    const index = this.kernel.wma_lossless_channel(
      state.byteOffset,
      reader.buffer.byteOffset,
      reader.index,
      reader.sizeInBits,
    );
    if (index < 0) throw Error('Truncated WMA Lossless residue');
    reader.index = index;
  }
  finish(state: Int32Array): void {
    this.kernel.wma_lossless_finish(state.byteOffset);
  }
  decodeFrame(state: Int32Array, reader: BitReader): void {
    const index = this.kernel.wma_standard_frame(
      state.byteOffset,
      reader.buffer.byteOffset,
      reader.index,
      reader.sizeInBits,
    );
    if (index < 0) throw Error('Invalid WMA Standard frame');
    reader.index = index;
  }
  decodeProFrame(state: Int32Array, reader: BitReader): void {
    const index = this.kernel.wma_pro_frame(
      state.byteOffset,
      reader.buffer.byteOffset,
      reader.index,
      reader.sizeInBits,
    );
    if (index < 0) throw Error('Invalid WMA Pro subframe');
    reader.index = index;
  }
}

function createBackend(): Backend | null {
  const instance = instantiateEmbeddedWasm(WMA_AUDIO_WASM_BINARY, {}, reportWasmVideoFallback);
  if (!instance) return null;
  let backend: Backend;
  try {
    backend = new Backend(instance.exports as Kernel);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    reportWasmVideoFallback();
    return null;
  }
  return backend;
}

export function createWmaLosslessDecoder(config: LosslessConfig): WmaLosslessDecoder | null {
  const backend = createBackend();
  return backend ? new WmaLosslessDecoder(config, backend) : null;
}

export function createWmaStandardDecoder(config: StandardConfig): WmaStandardDecoder | null {
  const backend = createBackend();
  return backend ? new WmaStandardDecoder(config, backend) : null;
}

export function createWmaProDecoder(config: ProConfig): WmaProDecoder | null {
  const backend = createBackend();
  return backend ? new WmaProDecoder(config, backend) : null;
}
