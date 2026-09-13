import type {AokanaBpMemory} from '../bp/memory.js';
import type {AokanaBpThread} from '../bp/state.js';
import type {AokanaBpDiagnostics} from './diagnostics.js';

/** Exact handler results consumed at native 0x1400ecacc; these are not frame yields. */
export type AokanaBpHandlerResult = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface AokanaBpOpcodeContext {
  readonly thread: AokanaBpThread;
  readonly memory: AokanaBpMemory;
  readonly diagnostics: AokanaBpDiagnostics;
}

/** A browser promise preserves a blocking native call; it is not a native scheduler result. */
export type AokanaBpInstructionResult = AokanaBpHandlerResult | Promise<AokanaBpHandlerResult>;
export type AokanaBpOpcodeHandler = (context: AokanaBpOpcodeContext) => AokanaBpInstructionResult;

/** The three-word FIFO accepted by this executable's CProcess, not a shared VN interface. */
export interface AokanaBpProcessMessage {
  readonly code: number;
  readonly value1: number;
  readonly value2: number;
}

export interface AokanaBpWaitProcess {
  /** Native vtable +8. Only -1 and +1 destroy the installed process. */
  poll(): number | Promise<number>;
  enqueueMessage(message: AokanaBpProcessMessage): void;
  dispose(): void;
}

/** Resource names retain native byte identity until the title's archive lookup boundary. */
export interface AokanaBpModuleResourceSource {
  readModule(
    archiveName: Uint8Array | null,
    resourceName: Uint8Array,
  ): Uint8Array | null | Promise<Uint8Array | null>;
}

export interface AokanaNativeSlotDefinition {
  readonly primary: number;
  readonly secondary: number;
  readonly nativeAddress: number;
  readonly name: string;
  readonly execute: AokanaBpOpcodeHandler;
}
