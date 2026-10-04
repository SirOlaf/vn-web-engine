import type {YuvFrame} from '../../video/frame.js';
import {Mpeg1ReferenceDecoder, type MpegSequence} from './reference.js';
import {Mpeg1WasmDecoder} from './wasm-decoder.js';
export {ZIGZAG, type MpegSequence} from './reference.js';

/**
 * MPEG-1 video elementary stream; incrementally accepts arbitrary byte boundaries. Decodes in
 * WebAssembly when available, otherwise with the identical JavaScript reference. Returned
 * pictures belong to the caller.
 */
export class Mpeg1Decoder {
  private readonly backend: Mpeg1WasmDecoder | Mpeg1ReferenceDecoder;
  constructor(options: {wasm?: boolean} = {}) {
    this.backend =
      (options.wasm === false ? null : Mpeg1WasmDecoder.create()) ?? new Mpeg1ReferenceDecoder();
  }
  /** Whether this decoder runs in WebAssembly. */
  get accelerated(): boolean {
    return this.backend instanceof Mpeg1WasmDecoder;
  }
  get sequence(): MpegSequence | undefined {
    return this.backend.sequence;
  }
  push(bytes: Uint8Array): YuvFrame[] {
    return this.backend.push(bytes);
  }
  flush(): YuvFrame[] {
    return this.backend.flush();
  }
}
