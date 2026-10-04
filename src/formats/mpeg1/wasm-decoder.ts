import {instantiateEmbeddedWasm} from '../../core/wasm.js';
import {reportWasmVideoFallback} from '../../platform/runtime-advisories.js';
import type {YuvFrame} from '../../video/frame.js';
import {BASIS_BY_FREQUENCY} from './idct.js';
import {MPEG_PENDING_LIMIT, RATES, type MpegSequence} from './reference.js';
import * as T from './tables.js';
import {MPEG1_VIDEO_WASM_BINARY} from './wasm-binary.js';

interface Mpeg1Exports {
  memory: WebAssembly.Memory;
  vlc_index(): number;
  vlc_data(): number;
  vlc_capacity(): number;
  basis(): number;
  failure(): number;
  sequence(): number;
  init(): number;
  pending_end(): number;
  pending_length(): number;
  push(length: number): number;
  flush(): number;
}

/** The Rust decoder's table order. */
const TABLES = [
  T.AC,
  T.ADDRESS,
  T.CBP,
  T.MOTION,
  T.DC_Y,
  T.DC_C,
  T.I_TYPE,
  T.P_TYPE,
  T.B_TYPE,
] as const;
/** Codes up to this length decode with one lookup; longer ones continue in the tree. */
const PRIMARY_BITS = 10;

/** A prefix code's lookup table and tree in the layout `wasm/mpeg1-video/src/bits.rs` reads. */
function encodeVlc(entries: readonly (readonly [string, number])[]): {
  lookup: Uint32Array;
  primary: number;
  tree: Uint32Array;
} {
  const zero = [0],
    one = [0],
    leaf = [0];
  for (const [code, value] of entries) {
    let node = 0;
    for (const bit of code) {
      const branch = bit === '1' ? one : zero;
      if (!branch[node]) {
        branch[node] = zero.length;
        zero.push(0);
        one.push(0);
        leaf.push(0);
      }
      node = branch[node]!;
    }
    leaf[node] = (0x80000000 | (value & 0xffff)) >>> 0;
  }
  const primary = Math.min(PRIMARY_BITS, Math.max(...entries.map(([code]) => code.length))),
    lookup = new Uint32Array(1 << primary);
  for (let prefix = 0; prefix < lookup.length; prefix++) {
    let node = 0;
    for (let length = 1; length <= primary; length++) {
      node = ((prefix >>> (primary - length)) & 1 ? one : zero)[node]!;
      if (!node) break;
      if (leaf[node]) {
        lookup[prefix] = ((1 << 30) | (length << 16) | (leaf[node]! & 0xffff)) >>> 0;
        break;
      }
    }
    if (node && !leaf[node]) lookup[prefix] = ((2 << 30) | node) >>> 0;
  }
  const tree = new Uint32Array(zero.length * 3);
  for (let node = 0; node < zero.length; node++)
    tree.set([zero[node]!, one[node]!, leaf[node]!], node * 3);
  return {lookup, primary, tree};
}

let encodedTables: {index: Uint32Array; data: Uint32Array} | undefined;
function vlcTables(): {index: Uint32Array; data: Uint32Array} {
  if (encodedTables) return encodedTables;
  const index = new Uint32Array(TABLES.length * 3),
    parts: Uint32Array[] = [];
  let length = 0;
  TABLES.forEach((entries, table) => {
    const {lookup, primary, tree} = encodeVlc(entries);
    index.set([length, primary, length + lookup.length], table * 3);
    parts.push(lookup, tree);
    length += lookup.length + tree.length;
  });
  const data = new Uint32Array(length);
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }
  return (encodedTables = {index, data});
}

/** Messages of the reference decoder, by the Rust failure code. */
const MESSAGES: Record<number, string> = {
  3: 'Unsupported MPEG sequence dimensions/rate',
  4: 'MPEG resolution changes are unsupported',
  5: 'Invalid MPEG sequence marker',
  6: 'Zero MPEG quantization matrix entry',
  7: 'Picture precedes MPEG sequence',
  9: 'Zero MPEG motion f_code',
  10: 'Slice precedes MPEG picture',
  11: 'Unsupported IDCPREC extension',
  13: 'Zero slice quantizer',
  14: 'Macroblock address exceeds picture',
  15: 'Skipped intra macroblock',
  16: 'Invalid skipped B macroblock',
  17: 'Zero macroblock quantizer',
  18: 'Overlapping/out-of-range MPEG macroblock',
  19: 'Missing MPEG reference picture',
  20: 'Inter macroblock has no prediction',
  21: 'Empty coded block',
  22: 'Zero escaped DCT level',
  23: 'DCT run exceeds block',
  24: 'Incomplete MPEG picture',
  25: 'Too many pictures in one MPEG input chunk; feed smaller chunks',
  26: 'Missing MPEG start code',
  27: 'Truncated MPEG start code',
  28: 'MPEG decoder memory allocation failed',
};

/**
 * `Mpeg1ReferenceDecoder` in WebAssembly (`wasm/mpeg1-video`). Pictures, input and decoder state
 * stay in one private instance; output pictures are copied out as they are emitted. Output, the
 * `sequence`, and every error message match the reference.
 */
export class Mpeg1WasmDecoder {
  sequence?: MpegSequence;
  private out: YuvFrame[] = [];
  private failed = false;
  private ended = false;
  private constructor(private readonly kernel: Mpeg1Exports) {}

  /** Null when WebAssembly or SIMD is unavailable, or the instance cannot reserve its input. */
  static create(): Mpeg1WasmDecoder | null {
    let decoder: Mpeg1WasmDecoder | undefined;
    const instance = instantiateEmbeddedWasm(
      MPEG1_VIDEO_WASM_BINARY,
      {
        env: {
          mpeg1_emit: (
            y: number,
            cb: number,
            cr: number,
            index: number,
            pictureType: number,
            temporalReference: number,
          ) => decoder!.emit(y >>> 0, cb >>> 0, cr >>> 0, index, pictureType, temporalReference),
        },
      },
      reportWasmVideoFallback,
    );
    if (instance === null) return null;
    const kernel = instance.exports as unknown as Mpeg1Exports,
      {index, data} = vlcTables();
    if (data.length > kernel.vlc_capacity()) return null;
    const buffer = kernel.memory.buffer;
    new Uint32Array(buffer, kernel.vlc_index() >>> 0, index.length).set(index);
    new Uint32Array(buffer, kernel.vlc_data() >>> 0, data.length).set(data);
    new Float64Array(buffer, kernel.basis() >>> 0, 64).set(BASIS_BY_FREQUENCY);
    if (kernel.init() !== 0) return null;
    return (decoder = new Mpeg1WasmDecoder(kernel));
  }

  push(bytes: Uint8Array): YuvFrame[] {
    if (this.failed || this.ended) throw new Error('MPEG decoder cannot accept more data');
    const kernel = this.kernel;
    if (kernel.pending_length() + bytes.length > MPEG_PENDING_LIMIT)
      throw new Error('MPEG section exceeds memory limit');
    new Uint8Array(kernel.memory.buffer, kernel.pending_end() >>> 0, bytes.length).set(bytes);
    return this.run(() => kernel.push(bytes.length));
  }

  flush(): YuvFrame[] {
    if (this.failed || this.ended) throw new Error('MPEG decoder already closed');
    const out = this.run(() => this.kernel.flush());
    this.ended = true;
    return out;
  }

  private run(call: () => number): YuvFrame[] {
    const out: YuvFrame[] = [];
    this.out = out;
    let status: number;
    try {
      status = call();
    } finally {
      this.out = [];
      this.readSequence();
    }
    if (status !== 0) {
      this.failed = true;
      throw this.failure();
    }
    return out;
  }

  private readSequence(): void {
    const [has, width, height, aspectCode, rate] = new Uint32Array(
      this.kernel.memory.buffer,
      this.kernel.sequence() >>> 0,
      5,
    );
    if (!has) return;
    const s = this.sequence,
      frameRate = RATES[rate!]!;
    if (
      !s ||
      s.width !== width ||
      s.height !== height ||
      s.aspectCode !== aspectCode ||
      s.frameRate !== frameRate
    )
      this.sequence = {width: width!, height: height!, aspectCode: aspectCode!, frameRate};
  }

  private emit(
    y: number,
    cb: number,
    cr: number,
    index: number,
    pictureType: number,
    temporalReference: number,
  ): void {
    this.readSequence();
    const s = this.sequence!,
      stride = Math.ceil(s.width / 16) * 16,
      paddedHeight = Math.ceil(s.height / 16) * 16,
      size = stride * paddedHeight,
      buffer = this.kernel.memory.buffer;
    this.out.push({
      width: s.width,
      height: s.height,
      stride,
      paddedHeight,
      y: new Uint8Array(buffer, y, size).slice(),
      cb: new Uint8Array(buffer, cb, size / 4).slice(),
      cr: new Uint8Array(buffer, cr, size / 4).slice(),
      index,
      pictureType,
      temporalReference,
    });
  }

  private failure(): Error {
    const [code, a, b, c, inSlice, temporal, pictureType, slice, address, bit] = new Int32Array(
      this.kernel.memory.buffer,
      this.kernel.failure() >>> 0,
      10,
    ) as unknown as number[];
    const message =
      code === 1
        ? `Invalid range ${a}+${b} of ${c}`
        : code === 2
          ? `Invalid VLC at bit ${a}`
          : code === 8
            ? `Unsupported MPEG picture type ${a}`
            : code === 12
              ? `Unsupported MPEG start code 0x${a!.toString(16)} (MPEG-2 extensions are not MPEG-1)`
              : (MESSAGES[code!] ?? `MPEG decoder failure ${code}`);
    const error = new Error(message);
    return inSlice
      ? new Error(
          `MPEG picture ${temporal} type ${pictureType}, slice ${slice}, MB ${address}, bit ${bit}: ${message}`,
          {cause: error},
        )
      : error;
  }
}
