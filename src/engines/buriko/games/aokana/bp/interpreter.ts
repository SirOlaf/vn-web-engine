import {AOKANA_NATIVE_SLOT_ADDRESSES, AOKANA_PRIMARY_SLOT_ADDRESSES} from '../native/inventory.js';
import type {AokanaNativeBank} from '../native/registry.js';
import type {
  AokanaBpInstructionResult,
  AokanaBpOpcodeContext,
  AokanaBpOpcodeHandler,
} from '../native/types.js';
import {writeWatchOpcodes} from '../native/write-watch-opcodes.js';
import {fetchOpcode, readU8} from './decode.js';
import type {AokanaBpModuleExtensions} from './module-extensions.js';
import type {AokanaBpThread} from './state.js';

export type AokanaBpDispatchResult =
  | {readonly defined: false; readonly opcode: number}
  | {
      readonly defined: true;
      readonly opcode: number;
      readonly result: AokanaBpInstructionResult;
    };

/** Instruction dispatch only. Construction requires a complete fixed native bank and primary set. */
export class AokanaBpInterpreter {
  private readonly primary: readonly (AokanaBpOpcodeHandler | undefined)[];

  constructor(
    directPrimaryHandlers: Readonly<Record<number, AokanaBpOpcodeHandler>>,
    nativeBank: AokanaNativeBank,
    extensions: AokanaBpModuleExtensions,
    private readonly contextForThread: (thread: AokanaBpThread) => AokanaBpOpcodeContext,
  ) {
    const handlers: (AokanaBpOpcodeHandler | undefined)[] = new Array(256);
    for (const [key, handler] of Object.entries({...directPrimaryHandlers, ...writeWatchOpcodes})) {
      const opcode = Number(key);
      if (
        AOKANA_PRIMARY_SLOT_ADDRESSES[opcode] === undefined ||
        AOKANA_NATIVE_SLOT_ADDRESSES[opcode] !== undefined ||
        opcode === 0xff ||
        typeof handler !== 'function'
      ) {
        throw new Error(`Invalid direct Aokana primary definition ${key}`);
      }
      handlers[opcode] = handler;
    }
    for (const key of Object.keys(AOKANA_NATIVE_SLOT_ADDRESSES)) {
      const primary = Number(key);
      handlers[primary] = (context) => nativeBank.execute(primary, readU8(context.thread), context);
    }
    handlers[0xff] = (context) => extensions.execute(context);
    for (const key of Object.keys(AOKANA_PRIMARY_SLOT_ADDRESSES)) {
      if (handlers[Number(key)] === undefined) {
        throw new Error(
          `Aokana primary opcode 0x${Number(key).toString(16)} has no complete implementation`,
        );
      }
    }
    this.primary = handlers;
  }

  /** The distributed interpreter lower distinguishes a genuinely empty primary slot from a handler fault. */
  dispatchNext(thread: AokanaBpThread, actor?: object): AokanaBpDispatchResult {
    const opcode = fetchOpcode(thread);
    const handler = this.primary[opcode];
    if (handler === undefined) return {defined: false, opcode};
    const original = this.contextForThread(thread);
    const context = actor === undefined ? original : {...original, actor};
    if (context.thread !== thread)
      throw new Error('Aokana opcode context refers to another thread');
    return {defined: true, opcode, result: handler(context)};
  }

  step(thread: AokanaBpThread, actor?: object): AokanaBpInstructionResult {
    const dispatched = this.dispatchNext(thread, actor);
    if (!dispatched.defined) {
      throw new Error(
        `Invalid Aokana primary opcode 0x${dispatched.opcode.toString(16)} at 0x${thread.instructionStart.toString(16)}`,
      );
    }
    return dispatched.result;
  }
}
