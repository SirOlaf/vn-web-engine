import {decodeDsc} from '../../../formats/buriko/dsc.js';
import {signature} from '../../../formats/buriko/binary.js';
import {instantiateEmbeddedWasm} from '../../../core/wasm.js';
import {recordRuntimeMetric} from '../../../platform/runtime-performance.js';
import {BURIKO_BITMAP_WASM_BINARY} from './bitmap-alpha-wasm-binary.js';

interface BurikoDscExports {
  memory: WebAssembly.Memory;
  __heap_base: WebAssembly.Global;
  dsc_decode: (input: number, inputLength: number, output: number, size: number) => number;
}

const DSC_HEADER_BYTES = 0x220;
// Input, eight zero padding bytes for the kernel's unaligned bit reads, and output
// with sixteen bytes of slack for chunked back-reference copies.
const DSC_WASM_MAX_WORKSPACE = 256 * 1024 * 1024;

let kernel: BurikoDscExports | null | undefined;
let bytesView: Uint8Array | null = null;

/** This realm's DSC instance of the bitmap kernel module; its memory grows to the largest resource. */
function dscKernel(): BurikoDscExports | null {
  if (kernel === undefined) {
    const instance = instantiateEmbeddedWasm(BURIKO_BITMAP_WASM_BINARY);
    kernel = instance === null ? null : (instance.exports as unknown as BurikoDscExports);
  }
  return kernel;
}

/**
 * DSC 1.00 decoding through the Buriko bitmap Wasm module. Only a successful
 * kernel status is used; every other status, and any case the kernel cannot
 * stage, reruns the reference `decodeDsc`, which raises the exact native error.
 */
export function decodeBurikoDsc(bytes: Uint8Array, maxBytes = 0x4000000): Uint8Array {
  const decoded = tryDecodeDscWasm(bytes, maxBytes);
  recordRuntimeMetric('buriko.decode.dsc.wasm-applied', Number(decoded !== null));
  return decoded ?? decodeDsc(bytes, maxBytes);
}

function tryDecodeDscWasm(bytes: Uint8Array, maxBytes: number): Uint8Array | null {
  if (bytes.length < DSC_HEADER_BYTES || !signature(bytes, 'DSC FORMAT 1.00\0')) return null;
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(20, true);
  if (size > maxBytes) return null;
  const kernel = dscKernel();
  if (kernel === null) return null;
  const memory = kernel.memory,
    input = Math.ceil(Number(kernel.__heap_base.value) / 16) * 16,
    output = input + Math.ceil((bytes.length + 8) / 16) * 16,
    end = output + size + 16;
  if (end > DSC_WASM_MAX_WORKSPACE) return null;
  if (end > memory.buffer.byteLength) {
    try {
      memory.grow(Math.ceil((end - memory.buffer.byteLength) / 65536));
    } catch {
      return null;
    }
  }
  if (bytesView?.buffer !== memory.buffer) bytesView = new Uint8Array(memory.buffer);
  const heap = bytesView;
  heap.set(bytes, input);
  heap.fill(0, input + bytes.length, input + bytes.length + 8);
  if (kernel.dsc_decode(input, bytes.length, output, size) !== 0) return null;
  return heap.slice(output, output + size);
}
