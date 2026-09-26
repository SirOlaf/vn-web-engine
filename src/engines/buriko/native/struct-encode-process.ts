import {push32} from '../bp/state.js';
import type {BurikoBpPointer} from '../bp/memory.js';
import type {BurikoNativeClock} from './clock.js';
import type {BurikoDataCodecWorker, BurikoDataCodecWorkers} from './data-codec-workers.js';
import {BurikoProcedure, type BurikoProcedureState} from './procedure.js';
import type {BurikoResourceLoadingState} from './resource-loading.js';
import type {BurikoStructCodecScratch} from './struct-codec-scratch.js';
import type {BurikoBpOpcodeContext} from './types.js';

/** CProcEncodeStruct 07AC60/07ABD0/07AC10. */
export class BurikoStructEncodeProcess extends BurikoProcedure {
  readonly worker: BurikoDataCodecWorker | null;
  constructor(
    context: BurikoBpOpcodeContext,
    procedures: BurikoProcedureState,
    clock: BurikoNativeClock,
    private readonly loading: BurikoResourceLoadingState,
    private readonly workers: BurikoDataCodecWorkers,
    scratch: BurikoStructCodecScratch,
    destination: BurikoBpPointer | null,
    source: BurikoBpPointer | null,
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
    if (this.worker === null) throw new Error('Buriko struct encoder has no started worker');
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
