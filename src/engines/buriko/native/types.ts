import type {BurikoBpMemory} from '../bp/memory.js';
import type {BurikoBpThread} from '../bp/state.js';
import type {BurikoBpDiagnostics} from './diagnostics.js';

/** Exact handler results consumed at native 0x1400ecacc; these are not frame yields. */
export type BurikoBpHandlerResult = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface BurikoBpOpcodeContext {
  readonly actor?: object;
  readonly thread: BurikoBpThread;
  readonly memory: BurikoBpMemory;
  readonly diagnostics: BurikoBpDiagnostics;
}

/** A browser promise preserves a blocking native call; it is not a native scheduler result. */
export type BurikoBpInstructionResult = BurikoBpHandlerResult | Promise<BurikoBpHandlerResult>;
export type BurikoBpOpcodeHandler = (context: BurikoBpOpcodeContext) => BurikoBpInstructionResult;

/** The three-word FIFO accepted by this executable's CProcess, not a shared VN interface. */
export interface BurikoBpProcessMessage {
  readonly code: number;
  readonly value1: number;
  readonly value2: number;
}

export interface BurikoBpWaitProcess {
  /** Native vtable +8. Only -1 and +1 destroy the installed process. */
  poll(): number | Promise<number>;
  enqueueMessage(message: BurikoBpProcessMessage): void;
  dispose(): void;
  /** A detached host completion may still write borrowed BP storage after poll returns. */
  hasOutstandingExternalBorrow?(): boolean;
  /** Its synchronous dispose publishes a result to the thread's operand storage. */
  needsLiveOperandStorageOnDispose?(): boolean;
}

/** Resource names retain native byte identity until the title's archive lookup boundary. */
export interface BurikoBpModuleResourceSource {
  readModule(
    archiveName: Uint8Array | null,
    resourceName: Uint8Array,
    retry?: boolean,
    actor?: object,
  ): Uint8Array | null | Promise<Uint8Array | null>;
}

export interface BurikoNativeSlotDefinition {
  readonly primary: number;
  readonly secondary: number;
  readonly nativeAddress: number;
  readonly name: string;
  readonly execute: BurikoBpOpcodeHandler;
}
