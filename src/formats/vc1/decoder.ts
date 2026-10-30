import {Vc1Decoder as ReferenceDecoder, type Vc1Picture} from './reference.js';
import {Vc1WasmDecoder} from './wasm-decoder.js';
export {
  FOURCC_WMV3,
  FOURCC_WVC1,
  PICTURE_I,
  PICTURE_P,
  Vc1Error,
  type Vc1Picture,
} from './reference.js';

/** Complete progressive VC-1 media objects, with Rust SIMD pixel operations when
 * available and an identical JavaScript fallback. Returned planes are decoder-owned. */
export class Vc1Decoder {
  private readonly backend: Vc1WasmDecoder | ReferenceDecoder;
  constructor(
    fourcc: number,
    width: number,
    height: number,
    extra: Uint8Array,
    options: {wasm?: boolean} = {},
  ) {
    this.backend =
      (options.wasm === false ? null : Vc1WasmDecoder.create(fourcc, width, height, extra)) ??
      new ReferenceDecoder(fourcc, width, height, extra);
  }
  get accelerated(): boolean {
    return this.backend instanceof Vc1WasmDecoder;
  }
  get width(): number {
    return this.backend.width;
  }
  get height(): number {
    return this.backend.height;
  }
  decode(data: Uint8Array | null, time: number): Vc1Picture | null {
    return this.backend.decode(data, time);
  }
}
