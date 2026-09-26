import {push32} from '../bp/state.js';
import type {BurikoBpPointer} from '../bp/memory.js';
import type {BurikoNativeClock} from './clock.js';
import type {BurikoDataCodecWorker, BurikoDataCodecWorkers} from './data-codec-workers.js';
import {BurikoProcedure, type BurikoProcedureState} from './procedure.js';
import type {BurikoResourceLoadingState} from './resource-loading.js';
import type {BurikoBpOpcodeContext} from './types.js';

/** CProcEncodeData 07AB60/07AAD0/07AB10. */
export class BurikoSdcEncodeProcess extends BurikoProcedure {
  readonly worker: BurikoDataCodecWorker | null;
  constructor(
    context: BurikoBpOpcodeContext,
    procedures: BurikoProcedureState,
    clock: BurikoNativeClock,
    private readonly loading: BurikoResourceLoadingState,
    private readonly workers: BurikoDataCodecWorkers,
    destination: BurikoBpPointer | null,
    source: BurikoBpPointer | null,
    count: number,
  ) {
    super(context.thread, procedures, clock);
    this.worker = workers.startEncode(destination, source, count);
    if (this.worker !== null) loading.enterProcedure();
  }

  poll(): number {
    this.consumeMessages();
    this.workers.checkFailure();
    if (this.worker === null) throw new Error('Buriko encoder procedure has no started worker');
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
