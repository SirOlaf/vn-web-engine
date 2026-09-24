import type {AokanaBpPointer} from '../bp/memory.js';
import {push32} from '../bp/state.js';
import type {AokanaNativeClock} from './clock.js';
import type {AokanaBmvRegistry} from './bmv-registry.js';
import {AokanaLoadProcedure} from './load-procedure.js';
import type {AokanaProcedureState} from './procedure.js';
import type {AokanaResourceLoadingState} from './resource-loading.js';
import {textBytes} from './text.js';
import type {AokanaBpOpcodeContext} from './types.js';

/** DCProcLoadBurikoMV 09CE80/09CD90/09CE30 over the existing CProcLoad resource FIFO. */
export class AokanaBmvLoadProcess extends AokanaLoadProcedure {
  private finalStatus = 1;
  private unavailable = false;
  private constructor(
    context: AokanaBpOpcodeContext,
    procedures: AokanaProcedureState,
    clock: AokanaNativeClock,
    loading: AokanaResourceLoadingState,
    private readonly registry: AokanaBmvRegistry,
    private readonly handleOutput: AokanaBpPointer | null,
    private readonly metadataOutput: AokanaBpPointer | null,
    archive: Uint8Array | null,
    name: Uint8Array,
  ) {
    // 07B180 passes availability=1 and cacheEligible=0 to 07ACD0.
    super(context, procedures, clock, loading, archive, name, {cacheEligible: false});
  }

  static async create(
    context: AokanaBpOpcodeContext,
    procedures: AokanaProcedureState,
    clock: AokanaNativeClock,
    loading: AokanaResourceLoadingState,
    registry: AokanaBmvRegistry,
    handleOutput: AokanaBpPointer | null,
    metadataOutput: AokanaBpPointer | null,
    archivePointer: AokanaBpPointer | null,
    namePointer: AokanaBpPointer | null,
  ): Promise<AokanaBmvLoadProcess> {
    if (namePointer === null)
      return loading.resources.errors.threadFatal(
        context.thread,
        context.diagnostics,
        loading.resources.files.text.encodeWide(
          'ファイル名へのポインタにNULLが指定されています',
          0,
        ),
      );
    const archive = archivePointer === null ? null : textBytes(archivePointer).slice(),
      name = textBytes(namePointer).slice(),
      process = new AokanaBmvLoadProcess(
        context,
        procedures,
        clock,
        loading,
        registry,
        handleOutput,
        metadataOutput,
        archive,
        name,
      );
    if (!(await loading.ranges.isAvailable(archive, name))) process.unavailable = true;
    else loading.enqueueOwned(process.output, process.result, process.archiveName, process.name);
    return process;
  }

  override poll(): Promise<number> {
    return this.unavailable ? Promise.resolve(1) : super.poll();
  }

  protected complete(): number {
    if (this.output.bytes === null)
      throw new Error('Aokana BMV load has no successful encoded resource');
    const status = this.registry.register(
      this.handleOutput,
      this.metadataOutput,
      this.output.bytes,
      this.result.value,
    );
    this.finalStatus = status === 0x80000001 ? 1 : status === 0x80000002 ? 2 : status;
    return 1;
  }

  override dispose(): void {
    push32(this.thread, this.finalStatus);
    super.dispose();
  }
}
