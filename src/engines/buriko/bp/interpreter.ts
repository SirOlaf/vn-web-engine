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

  step(thread: BurikoBpThread, actor?: object): BurikoBpInstructionResult {
    const dispatched = this.dispatchNext(thread, actor);
    if (!dispatched.defined) {
      throw new Error(
        `Invalid Buriko primary opcode 0x${dispatched.opcode.toString(16)} at 0x${thread.instructionStart.toString(16)}`,
      );
    }
    return dispatched.result;
  }
}
