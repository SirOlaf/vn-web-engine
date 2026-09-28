import {BURIKO_PRIMARY_SLOT_ADDRESSES} from '../native/inventory.js';
import {burikoNativeSlots, burikoPrimarySlots, type BurikoNativeBank} from '../native/registry.js';
import {BURIKO_BP_ABI_172, type BurikoBpAbi} from './abi.js';
import type {
  BurikoBpInstructionResult,
  BurikoBpOpcodeContext,
  BurikoBpOpcodeHandler,
} from '../native/types.js';
import {writeWatchOpcodes} from '../native/write-watch-opcodes.js';
import {fetchOpcode, readU8} from './decode.js';
import type {BurikoBpModuleExtensions} from './module-extensions.js';
import type {BurikoBpThread} from './state.js';
import {controlOpcodes} from './opcodes/control.js';
import {integerOpcodes} from './opcodes/integer.js';
import {memoryOpcodes} from './opcodes/memory.js';
import {localOpcodes} from './opcodes/locals.js';
import {fixedOpcodes} from './opcodes/fixed.js';
import {nativeMathOpcodes} from './opcodes/native-math.js';

// Scalar/stack operations, watched scalar stores, local-descriptor forms and control
// flow whose operands (fixed-width or varint immediates) bound their work. A watched
// store searches the registered watches and reports through a synchronous callback.
// Bulk memory, native calls and extensions check time after every instruction unless
// a native definition opts in. Identity checks below exclude replacement handlers.
const batchableHandlers: Readonly<Record<number, BurikoBpOpcodeHandler>> = Object.fromEntries(
  [
    0x00, 0x01, 0x02, 0x04, 0x05, 0x06, 0x08, 0x09, 0x0a, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13,
    0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x21, 0x22, 0x23,
    0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x32, 0x33,
    0x34, 0x35, 0x36, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3e, 0x3f, 0x40, 0x42, 0x56, 0x73, 0xe2, 0xe3,
    0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xee, 0xef,
  ].map((opcode) => [
    opcode,
    (controlOpcodes[opcode] ??
      integerOpcodes[opcode] ??
      memoryOpcodes[opcode] ??
      localOpcodes[opcode])!,
  ]),
);

/** The pure primary handlers an accelerated core may execute in their place. */
const directHandlers: Readonly<Record<number, BurikoBpOpcodeHandler>> = {
  ...controlOpcodes,
  ...integerOpcodes,
  ...memoryOpcodes,
  ...localOpcodes,
  ...fixedOpcodes,
  ...nativeMathOpcodes,
};

export type BurikoBpDispatchResult =
  | {readonly defined: false; readonly opcode: number}
  | {
      readonly defined: true;
      readonly opcode: number;
      readonly result: BurikoBpInstructionResult;
    };

/** Instruction dispatch only. Construction requires a complete fixed native bank and primary set. */
export class BurikoBpInterpreter {
  private readonly primary: readonly (BurikoBpOpcodeHandler | undefined)[];
  /** Scheduling hint only; the selected handlers and instruction results stay native. */
  readonly batchableOpcodes: readonly boolean[];
  /** Opcodes whose selected handler is the canonical pure handler, never a replacement. */
  readonly directOpcodes: readonly boolean[];
  private validatedContext: BurikoBpOpcodeContext | null = null;
  /** Per native primary, the secondaries whose bank definitions opted into batching. */
  readonly batchableNativeSlots: readonly (readonly boolean[] | undefined)[];

  constructor(
    directPrimaryHandlers: Readonly<Record<number, BurikoBpOpcodeHandler>>,
    nativeBank: BurikoNativeBank,
    extensions: BurikoBpModuleExtensions,
    private readonly contextForThread: (thread: BurikoBpThread) => BurikoBpOpcodeContext,
    readonly abi: BurikoBpAbi = BURIKO_BP_ABI_172,
  ) {
    if (nativeBank.abi.revision !== abi.revision)
      throw new Error('Buriko interpreter and native bank have different bytecode ABIs');
    const primarySlots = burikoPrimarySlots(abi);
    const nativeSlots = burikoNativeSlots(abi);
    const handlers: (BurikoBpOpcodeHandler | undefined)[] = new Array(256);
    for (const [key, handler] of Object.entries({...directPrimaryHandlers, ...writeWatchOpcodes})) {
      const opcode = Number(key);
      if (
        BURIKO_PRIMARY_SLOT_ADDRESSES[opcode] === undefined ||
        nativeSlots[opcode] !== undefined ||
        opcode === 0xff ||
        typeof handler !== 'function'
      ) {
        throw new Error(`Invalid direct Buriko primary definition ${key}`);
      }
      if (primarySlots[opcode] !== undefined) handlers[opcode] = handler;
    }
    for (const key of Object.keys(nativeSlots)) {
      const primary = Number(key);
      handlers[primary] = (context) => nativeBank.execute(primary, readU8(context.thread), context);
    }
    handlers[0xff] = (context) => extensions.execute(context);
    for (const key of Object.keys(primarySlots)) {
      if (handlers[Number(key)] === undefined) {
        throw new Error(
          `Buriko primary opcode 0x${Number(key).toString(16)} has no complete implementation`,
        );
      }
    }
    this.primary = handlers;
    this.batchableNativeSlots = Object.freeze(
      Array.from({length: 256}, (_, opcode) =>
        nativeSlots[opcode] !== undefined ? nativeBank.batchableSecondaries(opcode) : undefined,
      ),
    );
    this.directOpcodes = Object.freeze(
      Array.from(
        {length: 256},
        (_, opcode) =>
          handlers[opcode] !== undefined && handlers[opcode] === directHandlers[opcode],
      ),
    );
    this.batchableOpcodes = Object.freeze(
      Array.from(
        {length: 256},
        (_, opcode) =>
          handlers[opcode] !== undefined && handlers[opcode] === batchableHandlers[opcode],
      ),
    );
  }

  /** The distributed interpreter lower distinguishes a genuinely empty primary slot from a handler fault. */
  dispatchNext(thread: BurikoBpThread, actor?: object): BurikoBpDispatchResult {
    const opcode = fetchOpcode(thread);
    const handler = this.primary[opcode];
    if (handler === undefined) return {defined: false, opcode};
    const original = this.contextForThread(thread);
    if (original.memory.abi.revision !== this.abi.revision)
      throw new Error('Buriko opcode context has a different bytecode ABI');
    const context = actor === undefined ? original : {...original, actor};
    if (context.thread !== thread)
      throw new Error('Buriko opcode context refers to another thread');
    return {defined: true, opcode, result: handler(context)};
  }

  /** dispatchNext without its result record; this runs once per scheduled instruction. */
  step(thread: BurikoBpThread, actor?: object): BurikoBpInstructionResult {
    const opcode = fetchOpcode(thread);
    const handler = this.primary[opcode];
    if (handler === undefined) {
      throw new Error(
        `Invalid Buriko primary opcode 0x${opcode.toString(16)} at 0x${thread.instructionStart.toString(16)}`,
      );
    }
    const original = this.contextForThread(thread);
    // A factory may return the same immutable context again; it was validated for this thread.
    if (original !== this.validatedContext || original.thread !== thread || actor !== undefined) {
      if (original.memory.abi.revision !== this.abi.revision)
        throw new Error('Buriko opcode context has a different bytecode ABI');
      const context = actor === undefined ? original : {...original, actor};
      if (context.thread !== thread)
        throw new Error('Buriko opcode context refers to another thread');
      if (actor !== undefined) return handler(context);
      this.validatedContext = original;
    }
    return handler(original);
  }
}
