import {instantiateEmbeddedWasm} from '../../../core/wasm.js';
import {reportWasmInterpreterFallback} from '../../../platform/runtime-advisories.js';
import type {BurikoBpDiagnostics} from '../native/diagnostics.js';
import type {BurikoBpMemory} from './memory.js';
import {BurikoBpArena} from './region.js';
import type {BurikoBpThread} from './state.js';
import {BURIKO_BP_WASM_BINARY} from './wasm-binary.js';

/** Opcodes `wasm/buriko-bp` implements; each also needs the interpreter's canonical handler. */
export const BURIKO_BP_WASM_OPCODES: ReadonlySet<number> = new Set([
  // control
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x37,
  0x3b, 0xee, 0xef,
  // integer
  0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f,
  0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x38, 0x39, 0x3a, 0x3c, 0x40, 0x42, 0x56, 0x73,
  // memory
  0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x18, 0x19, 0x1f, 0x3e, 0x3f, 0x60, 0x61, 0x62,
  0x63, 0x64, 0x65, 0xec, 0xed,
  // locals
  0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf0, 0xf1,
  0xf2, 0xf4, 0xf5, 0xf7, 0xf8, 0xf9, 0xfa, 0xfb,
]);

/** `Control` field indices in `wasm/buriko-bp/src/vm.rs`. */
const Field = {
  Pc: 0,
  InstructionStart: 1,
  StackIndex: 2,
  FrameCursor: 3,
  StackBase: 4,
  StackCapacity: 5,
  ModuleBase: 6,
  ModuleSize: 7,
  FrameBase: 8,
  FrameSize: 9,
  HeapBase: 10,
  HeapSize: 11,
  HasHeap: 12,
  GlobalBase: 13,
  GlobalSize: 14,
  FrameFloor: 15,
  FrameLimit: 16,
  CodeLimit: 17,
  AddressBits: 18,
  AddressMask: 19,
  ModuleTag: 20,
  FrameTag: 21,
  HeapTag: 22,
  IndirectHandles: 23,
  BitmapOffset: 24,
  WatchEnabled: 25,
  Limit: 26,
  Executed: 27,
  Result: 28,
  Status: 29,
  CallLogCount: 30,
  LastBatchable: 31,
} as const;

/** Why a run stopped. */
export const BurikoBpWasmStatus = {
  /** The limit was reached, or the call-site log filled. */
  Limit: 0,
  /** The next instruction needs the TypeScript handler; it has not been started. */
  Host: 1,
  /** The last instruction returned a nonzero handler result. */
  Result: 2,
  /** The last instruction is not batchable. */
  Unbatched: 3,
} as const;
export type BurikoBpWasmStatus = (typeof BurikoBpWasmStatus)[keyof typeof BurikoBpWasmStatus];

const FLAG_ENABLED = 1;
const FLAG_BATCHABLE = 2;
/** The high word of a call-log entry marks a removed call site. */
const CALL_POP = 1;

let enabled = true;

/** Disables the WebAssembly core for memories created afterwards (fallback testing). */
export function setBurikoBpWasmEnabled(value: boolean): void {
  enabled = value;
}

interface Exports {
  readonly bp_control: () => number;
  readonly bp_opcode_flags: () => number;
  readonly bp_call_log: () => number;
  readonly bp_run: () => void;
  readonly __heap_base: WebAssembly.Global;
}

/**
 * The interpreter core bound to one VM memory. It shares that memory's arena: regions are
 * addressed by their arena offsets, and the module's statics occupy the arena's reserved prefix.
 */
export class BurikoBpWasmCore {
  /** Handler result of the last instruction of the last run. */
  result = 0;
  /** Whether the last instruction of the last run is batchable. */
  batchable = true;
  /** Why the last run stopped. */
  status: BurikoBpWasmStatus = BurikoBpWasmStatus.Limit;
  /** Opcodes a run may start with, after `configure`. */
  readonly opcodes: boolean[] = Array<boolean>(256).fill(false);
  private readonly control: number;
  private readonly flags: number;
  private readonly callLog: number;
  private memory: BurikoBpMemory | null = null;
  private diagnostics: BurikoBpDiagnostics | null = null;

  private constructor(private readonly exports: Exports) {
    this.control = exports.bp_control() >>> 2;
    this.flags = exports.bp_opcode_flags();
    this.callLog = exports.bp_call_log() >>> 2;
  }

  /**
   * Creates the arena memory and its core, or returns null when WebAssembly is unavailable or
   * disabled; the caller then uses an `ArrayBuffer` arena and the TypeScript interpreter.
   */
  static create(
    initialBytes: number,
  ): {core: BurikoBpWasmCore; memory: WebAssembly.Memory; reserved: number} | null {
    if (!enabled || typeof WebAssembly !== 'object') return null;
    let memory: WebAssembly.Memory;
    try {
      memory = new WebAssembly.Memory({initial: BurikoBpArena.wasmPages(initialBytes)});
    } catch {
      reportWasmInterpreterFallback();
      return null;
    }
    const instance = instantiateEmbeddedWasm(
      BURIKO_BP_WASM_BINARY,
      {env: {memory}},
      reportWasmInterpreterFallback,
    );
    if (instance === null) return null;
    const exports = instance.exports as unknown as Exports;
    return {
      core: new BurikoBpWasmCore(exports),
      memory,
      reserved: Number(exports.__heap_base.value),
    };
  }

  /** Called once by the owning memory, after its arena exists. */
  attach(memory: BurikoBpMemory): void {
    this.memory = memory;
  }

  /**
   * Selects the opcodes wasm may execute: `direct[op]` means the interpreter runs the canonical
   * pure handler for `op`, and `batchable[op]` whether the scheduler amortizes its clock after it.
   */
  configure(
    direct: readonly boolean[],
    batchable: readonly boolean[],
    diagnostics: BurikoBpDiagnostics,
  ): void {
    this.diagnostics = diagnostics;
    const bytes = this.memory!.memoryViews().bytes;
    for (let opcode = 0; opcode < 256; opcode++) {
      this.opcodes[opcode] = direct[opcode] === true && BURIKO_BP_WASM_OPCODES.has(opcode);
      bytes[this.flags + opcode] =
        (this.opcodes[opcode] ? FLAG_ENABLED : 0) |
        (batchable[opcode] === true ? FLAG_BATCHABLE : 0);
    }
  }

  /**
   * Runs up to `limit` instructions of `thread` in place and returns how many completed. It
   * stops before an instruction that needs TypeScript, after a nonzero handler result, and after
   * an unbatched instruction; see `status`, `result` and `batchable`.
   */
  get blocked(): boolean {
    return this.status === BurikoBpWasmStatus.Host;
  }

  run(thread: BurikoBpThread, limit: number): number {
    const memory = this.memory!;
    if (thread.regions !== memory.regions || this.diagnostics === null) {
      this.status = BurikoBpWasmStatus.Host;
      return 0;
    }
    const stack = thread.stackRegion.arenaOffset,
      module = thread.moduleRegion.arenaOffset,
      frame = thread.frameRegion.arenaOffset,
      heap = thread.heap?.region.arenaOffset ?? -1;
    if (stack < 0 || module < 0 || frame < 0) {
      this.status = BurikoBpWasmStatus.Host;
      return 0;
    }
    const owner = thread.storageOwner,
      abi = memory.abi,
      views = memory.memoryViews(),
      words = views.words,
      c = this.control;
    words[c + Field.Pc] = thread.pc;
    words[c + Field.InstructionStart] = thread.instructionStart;
    words[c + Field.StackIndex] = thread.stackIndex;
    words[c + Field.FrameCursor] = thread.frameCursor;
    words[c + Field.StackBase] = stack;
    words[c + Field.StackCapacity] = thread.operandStack.length;
    words[c + Field.ModuleBase] = module;
    words[c + Field.ModuleSize] = thread.moduleRegion.size;
    words[c + Field.FrameBase] = frame;
    words[c + Field.FrameSize] = thread.frameRegion.size;
    words[c + Field.HeapBase] = heap < 0 ? 0 : heap;
    words[c + Field.HeapSize] = heap < 0 ? 0 : thread.heap!.region.size;
    words[c + Field.HasHeap] = heap < 0 ? 0 : 1;
    words[c + Field.GlobalBase] = memory.globalRegion.arenaOffset;
    words[c + Field.GlobalSize] = memory.globalRegion.size;
    words[c + Field.FrameFloor] = thread.frameFloor;
    words[c + Field.FrameLimit] = thread.frameLimit;
    words[c + Field.CodeLimit] = (owner.moduleFloor + owner.moduleCapacity) >>> 0;
    words[c + Field.AddressBits] = abi.addressBits;
    words[c + Field.AddressMask] = abi.addressMask;
    words[c + Field.ModuleTag] = abi.moduleTag;
    words[c + Field.FrameTag] = abi.frameTag;
    words[c + Field.HeapTag] = abi.heapTag;
    words[c + Field.IndirectHandles] = abi.indirectHandles ? 1 : 0;
    words[c + Field.BitmapOffset] = views.bitmapOffset;
    words[c + Field.WatchEnabled] = this.diagnostics.writeWatchEnabled ? 1 : 0;
    words[c + Field.Limit] = limit;
    this.exports.bp_run();
    thread.pc = words[c + Field.Pc]!;
    thread.instructionStart = words[c + Field.InstructionStart]!;
    thread.stackIndex = words[c + Field.StackIndex]!;
    thread.frameCursor = words[c + Field.FrameCursor]!;
    const entries = words[c + Field.CallLogCount]!;
    for (let entry = 0, at = this.callLog; entry < entries; entry++, at += 2) {
      if (words[at + 1] === CALL_POP) thread.callSites.pop();
      else thread.callSites.push(words[at]!);
    }
    this.result = words[c + Field.Result]!;
    this.status = words[c + Field.Status]! as BurikoBpWasmStatus;
    this.batchable = words[c + Field.LastBatchable] !== 0;
    return words[c + Field.Executed]!;
  }
}
