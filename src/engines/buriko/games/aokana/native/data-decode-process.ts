import {push32} from '../bp/state.js';
import type {AokanaBpPointer} from '../bp/memory.js';
import type {AokanaNativeClock} from './clock.js';
import type {AokanaDataCodecWorker, AokanaDataCodecWorkers} from './data-codec-workers.js';
import {AokanaProcedure, type AokanaProcedureState} from './procedure.js';
import type {AokanaResourceLoadingState} from './resource-loading.js';
import type {AokanaBpOpcodeContext} from './types.js';

/** DCProcDecodeData09B360/09B2C0/09B300: destructor, not poll, publishes the DWORD. */
export class AokanaDataDecodeProcess extends AokanaProcedure {
  readonly worker: AokanaDataCodecWorker | null;
  protected result = 0;
  constructor(
    context: AokanaBpOpcodeContext,
    procedures: AokanaProcedureState,
    clock: AokanaNativeClock,
    private readonly loading: AokanaResourceLoadingState,
    private readonly workers: AokanaDataCodecWorkers,
    destination: AokanaBpPointer | null,
    source: AokanaBpPointer | null,
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
    if (this.worker === null) throw new Error('Aokana data decoder has no started worker');
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
