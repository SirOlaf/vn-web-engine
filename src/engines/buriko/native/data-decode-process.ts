import {push32} from '../bp/state.js';
import type {BurikoBpPointer} from '../bp/memory.js';
import type {BurikoNativeClock} from './clock.js';
import type {BurikoDataCodecWorker, BurikoDataCodecWorkers} from './data-codec-workers.js';
import {BurikoProcedure, type BurikoProcedureState} from './procedure.js';
import type {BurikoResourceLoadingState} from './resource-loading.js';
import type {BurikoBpOpcodeContext} from './types.js';

/** DCProcDecodeData09B360/09B2C0/09B300: destructor, not poll, publishes the DWORD. */
export class BurikoDataDecodeProcess extends BurikoProcedure {
  readonly worker: BurikoDataCodecWorker | null;
  protected result = 0;
  constructor(
    context: BurikoBpOpcodeContext,
    procedures: BurikoProcedureState,
    clock: BurikoNativeClock,
    private readonly loading: BurikoResourceLoadingState,
    private readonly workers: BurikoDataCodecWorkers,
    destination: BurikoBpPointer | null,
    source: BurikoBpPointer | null,
    inputLength: number,
  ) {
    super(context.thread, procedures, clock);
    this.worker = workers.startDecode(
      destination,
      source,
      inputLength,
      loading.resources.mainProcessing,
    );
    if (this.worker !== null) loading.enterProcedure();
  }
  poll(): number {
    this.consumeMessages();
    this.workers.checkFailure();
    if (this.worker === null) throw new Error('Buriko data decoder has no started worker');
    if (!this.worker.done) return 0;
    this.result = this.worker.result;
    return 1;
  }
  override dispose(): void {
    push32(this.thread, this.result);
    if (this.worker !== null) {
      this.workers.release(this.worker);
      this.loading.leaveProcedure();
    }
    super.dispose();
  }
}
