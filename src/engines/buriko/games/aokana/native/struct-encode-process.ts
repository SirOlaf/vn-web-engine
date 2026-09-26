import {push32} from '../bp/state.js';
import type {AokanaBpPointer} from '../bp/memory.js';
import type {AokanaNativeClock} from './clock.js';
import type {AokanaDataCodecWorker, AokanaDataCodecWorkers} from './data-codec-workers.js';
import {AokanaProcedure, type AokanaProcedureState} from './procedure.js';
import type {AokanaResourceLoadingState} from './resource-loading.js';
import type {AokanaStructCodecScratch} from './struct-codec-scratch.js';
import type {AokanaBpOpcodeContext} from './types.js';

/** CProcEncodeStruct 07AC60/07ABD0/07AC10. */
export class AokanaStructEncodeProcess extends AokanaProcedure {
  readonly worker: AokanaDataCodecWorker | null;
  constructor(
    context: AokanaBpOpcodeContext,
    procedures: AokanaProcedureState,
    clock: AokanaNativeClock,
    private readonly loading: AokanaResourceLoadingState,
    private readonly workers: AokanaDataCodecWorkers,
    scratch: AokanaStructCodecScratch,
    destination: AokanaBpPointer | null,
    source: AokanaBpPointer | null,
    size: number,
    count: number,
  ) {
    super(context.thread, procedures, clock);
    this.worker = workers.startStructEncode(
      destination,
      source,
      size,
      count,
      scratch,
      loading.resources.errors,
    );
    if (this.worker !== null) loading.enterProcedure();
  }
  poll(): number {
    this.consumeMessages();
    this.workers.checkFailure();
    if (this.worker === null) throw new Error('Aokana struct encoder has no started worker');
    if (!this.worker.done) return 0;
    push32(this.thread, this.worker.result);
    return 1;
  }
  override dispose(): void {
    if (this.worker !== null) {
      this.workers.release(this.worker);
      this.loading.leaveProcedure();
    }
    super.dispose();
  }
}
