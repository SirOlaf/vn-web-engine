import type {AokanaBpPointer} from '../bp/memory.js';
import {push32, type AokanaBpThread} from '../bp/state.js';
import type {AokanaNativeClock} from './clock.js';
import type {AokanaInternetReadOperation, AokanaInternetReads} from './internet-reads.js';
import {AokanaProcedure, type AokanaProcedureState} from './procedure.js';
import {terminatedNativeBytes} from './program-files.js';
import type {AokanaResourceLoadingState} from './resource-loading.js';

/** DCProcReadFileFromInternet 09D430/09D310/09D3B0 over the actual process owner. */
export class AokanaInternetReadProcess extends AokanaProcedure {
  private readonly url: Uint8Array;
  private operation: AokanaInternetReadOperation | null = null;
  private firstPoll = true;
  private completed = false;
  private failed = false;
  private failure: unknown;
  private result = 0xffffffff;

  constructor(
    thread: AokanaBpThread,
    procedures: AokanaProcedureState,
    clock: AokanaNativeClock,
    private readonly loading: AokanaResourceLoadingState,
    private readonly reads: AokanaInternetReads,
    private readonly destination: AokanaBpPointer | null,
    url: Uint8Array,
    private readonly offset: number,
    private readonly length: number,
  ) {
    super(thread, procedures, clock);
    this.url = terminatedNativeBytes(url).slice();
    loading.enterProcedure();
  }

  poll(): number {
    this.consumeMessages();
    if (this.firstPoll) {
      this.operation = this.reads.start(
        this.destination,
        this.url,
        this.offset,
        this.length,
      );
      this.firstPoll = false;
      if (this.operation === null) return 0xffffffff;
      void this.operation.completion.then(
        (result) => {
          this.result = result >>> 0;
          this.completed = true;
        },
        (error: unknown) => {
          this.failure = error;
          this.failed = true;
          this.completed = true;
        },
      );
      return 0;
    }
    if (this.completed) {
      if (this.failed) throw this.failure;
      return 1;
    }
    if (!this.canRun()) this.operation?.cancelSession();
    return 0;
  }

  override dispose(): void {
    push32(this.thread, this.result);
    this.operation?.dispose();
    this.operation = null;
    this.loading.leaveProcedure();
    super.dispose();
  }
}
