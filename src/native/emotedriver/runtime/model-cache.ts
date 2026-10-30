import {readEmoteModel, type EmoteX64Model} from '../../../formats/kirikiri/emote-model.js';
import {PsbFile} from '../../../formats/kirikiri/psb.js';
import {EMOTE_PSB_KEYS} from '../../../formats/kirikiri/psb-filter.js';
import {EMOTEDRIVER_X64_SHA256} from '../build.js';

interface Entry {
  readonly bytes: Uint8Array;
  readonly model: EmoteX64Model;
  readonly equal: (other: Uint8Array) => boolean;
}

/**
 * (module (import "env" "memory" (memory 1))
 *   (func (export "cmp") (param $a i32) (param $b i32) (param $n i32) (result i32)
 *     (loop $next
 *       ;; or of four v128.xor pairs at offsets 0, 16, 32, 48
 *       (if (v128.any_true ...) (then (return (i32.const 0))))
 *       (local.set $a (i32.add (local.get $a) (i32.const 64)))
 *       (local.set $b (i32.add (local.get $b) (i32.const 64)))
 *       (br_if $next (i32.gt_s (local.tee $n (i32.sub (local.get $n) (i32.const 64))) (i32.const 0))))
 *     (i32.const 1)))
 * $n is a positive multiple of 64.
 */
// prettier-ignore
const EQUAL_WASM = Uint8Array.of(
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x01, 0x60, 0x03, 0x7f,
  0x7f, 0x7f, 0x01, 0x7f, 0x02, 0x0f, 0x01, 0x03, 0x65, 0x6e, 0x76, 0x06, 0x6d, 0x65,
  0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00, 0x01, 0x03, 0x02, 0x01, 0x00, 0x07, 0x07, 0x01,
  0x03, 0x63, 0x6d, 0x70, 0x00, 0x00, 0x0a, 0x6c, 0x01, 0x6a, 0x00, 0x03, 0x40, 0x20,
  0x00, 0xfd, 0x00, 0x04, 0x00, 0x20, 0x01, 0xfd, 0x00, 0x04, 0x00, 0xfd, 0x51, 0x20,
  0x00, 0xfd, 0x00, 0x04, 0x10, 0x20, 0x01, 0xfd, 0x00, 0x04, 0x10, 0xfd, 0x51, 0xfd,
  0x50, 0x20, 0x00, 0xfd, 0x00, 0x04, 0x20, 0x20, 0x01, 0xfd, 0x00, 0x04, 0x20, 0xfd,
  0x51, 0xfd, 0x50, 0x20, 0x00, 0xfd, 0x00, 0x04, 0x30, 0x20, 0x01, 0xfd, 0x00, 0x04,
  0x30, 0xfd, 0x51, 0xfd, 0x50, 0xfd, 0x53, 0x04, 0x40, 0x41, 0x00, 0x0f, 0x0b, 0x20,
  0x00, 0x41, 0xc0, 0x00, 0x6a, 0x21, 0x00, 0x20, 0x01, 0x41, 0xc0, 0x00, 0x6a, 0x21,
  0x01, 0x20, 0x02, 0x41, 0xc0, 0x00, 0x6b, 0x22, 0x02, 0x41, 0x00, 0x4a, 0x0d, 0x00,
  0x0b, 0x41, 0x01, 0x0b,
);
/** Caller bytes are staged through this many bytes behind the retained copy. */
const EQUAL_CHUNK = 16384;
let equalModule: WebAssembly.Module | null | undefined;

/**
 * A retained copy of `bytes` with an exact comparison. Where SIMD Wasm is available the
 * copy lives in a private memory and caller bytes are compared 128 bits at a time through
 * a cache-sized staging area; otherwise both sides are plain arrays.
 */
export function retainModelBytes(
  bytes: Uint8Array,
  compared: boolean,
): {bytes: Uint8Array; equal(other: Uint8Array): boolean} {
  if (compared && equalModule === undefined)
    try {
      equalModule = new WebAssembly.Module(EQUAL_WASM);
    } catch {
      equalModule = null;
    }
  const length = bytes.byteLength,
    whole = length - (length % 64),
    staging = (length + 15) & ~15;
  let memory: WebAssembly.Memory | null = null,
    compare: ((a: number, b: number, n: number) => number) | null = null;
  if (compared && equalModule && whole)
    try {
      memory = new WebAssembly.Memory({initial: Math.ceil((staging + EQUAL_CHUNK) / 65536)});
      compare = new WebAssembly.Instance(equalModule, {env: {memory}}).exports.cmp as (
        a: number,
        b: number,
        n: number,
      ) => number;
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      memory = null;
    }
  if (!memory || !compare) {
    const copy = new Uint8Array(bytes);
    return {bytes: copy, equal: (other) => sameModelBytes(copy, other)};
  }
  const copy = new Uint8Array(memory.buffer, 0, length),
    scratch = new Uint8Array(memory.buffer, staging, EQUAL_CHUNK);
  copy.set(bytes);
  return {
    bytes: copy,
    equal(other) {
      if (other.byteLength !== length) return false;
      for (let at = 0; at < whole; at += EQUAL_CHUNK) {
        const end = Math.min(whole, at + EQUAL_CHUNK);
        scratch.set(other.subarray(at, end));
        if (!compare(at, staging, end - at)) return false;
      }
      for (let i = whole; i < length; i++) if (copy[i] !== other[i]) return false;
      return true;
    },
  };
}

/** Exact byte equality; aligned views compare eight 32-bit words per branch. */
export function sameModelBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  const words = Math.floor(a.length / 4);
  if ((a.byteOffset | b.byteOffset) & 3) {
    const av = new DataView(a.buffer, a.byteOffset, a.byteLength),
      bv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < words * 4; i += 4)
      if (av.getUint32(i, true) !== bv.getUint32(i, true)) return false;
  } else {
    const av = new Int32Array(a.buffer, a.byteOffset, words),
      bv = new Int32Array(b.buffer, b.byteOffset, words),
      blocks = words - (words % 8);
    let i = 0;
    for (; i < blocks; i += 8)
      if (
        ((av[i]! ^ bv[i]!) |
          (av[i + 1]! ^ bv[i + 1]!) |
          (av[i + 2]! ^ bv[i + 2]!) |
          (av[i + 3]! ^ bv[i + 3]!) |
          (av[i + 4]! ^ bv[i + 4]!) |
          (av[i + 5]! ^ bv[i + 5]!) |
          (av[i + 6]! ^ bv[i + 6]!) |
          (av[i + 7]! ^ bv[i + 7]!)) !==
        0
      )
        return false;
    for (; i < words; i++) if (av[i] !== bv[i]) return false;
  }
  for (let i = words * 4; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Fresh identity keys for each file/resource group; definition data stays immutable. */
function instantiate(model: EmoteX64Model): EmoteX64Model {
  return {
    ...model,
    sources: new Map(
      [...model.sources].map(([name, source]) => [
        name,
        {...source, texture: source.texture ? {...source.texture} : null},
      ]),
    ),
    objects: new Map(
      [...model.objects].map(([name, object]) => [
        name,
        {
          ...object,
          motions: new Map([...object.motions].map(([label, motion]) => [label, {...motion}])),
        },
      ]),
    ),
  };
}

/** Device-local parsed definitions, bounded by entry count and retained source bytes. */
export class EmoteModelCache {
  private readonly entries: Entry[] = [];
  private bytes = 0;

  constructor(
    private readonly capacity = 4,
    private readonly byteLimit = 32 * 1024 * 1024,
  ) {
    if (
      !Number.isSafeInteger(capacity) ||
      capacity < 1 ||
      !Number.isSafeInteger(byteLimit) ||
      byteLimit < 1
    )
      throw new RangeError('Invalid E-mote model cache limits');
  }

  read(bytes: Uint8Array): EmoteX64Model {
    const index = this.entries.findIndex((entry) => entry.equal(bytes));
    if (index >= 0) {
      const entry = this.entries.splice(index, 1)[0]!;
      this.entries.push(entry);
      return instantiate(entry.model);
    }
    // Callers may reuse or change their buffers after the synchronous call.
    // Neither cache identity nor retained texture data may borrow those bytes.
    const retained = retainModelBytes(bytes, bytes.byteLength <= this.byteLimit),
      snapshot = retained.bytes,
      model = readEmoteModel(
        new PsbFile(snapshot, {
          driverSha256: EMOTEDRIVER_X64_SHA256,
          headerKey: EMOTE_PSB_KEYS.get(EMOTEDRIVER_X64_SHA256),
        }),
        EMOTEDRIVER_X64_SHA256,
      );
    if (snapshot.byteLength <= this.byteLimit) {
      while (
        this.entries.length >= this.capacity ||
        this.bytes + snapshot.byteLength > this.byteLimit
      ) {
        this.bytes -= this.entries.shift()!.bytes.byteLength;
      }
      this.entries.push({bytes: snapshot, model, equal: retained.equal});
      this.bytes += snapshot.byteLength;
    }
    return instantiate(model);
  }

  clear(): void {
    this.entries.length = 0;
    this.bytes = 0;
  }
}
