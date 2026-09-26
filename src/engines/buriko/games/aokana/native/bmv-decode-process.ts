import {push32, type AokanaBpThread} from '../bp/state.js';
import {AokanaProcedure, type AokanaProcedureState} from './procedure.js';
import type {AokanaNativeClock} from './clock.js';
import type {AokanaResourceLoadingState} from './resource-loading.js';
import type {AokanaBmvService, AokanaBmvWorker} from './bmv-service.js';

/** DCProcDecodeBMV 09B240/09B0B0/09B150/09B1F0. */
export class AokanaBmvDecodeProcess extends AokanaProcedure {
  private status = 0;
  private worker: AokanaBmvWorker | null = null;
  constructor(
    thread: AokanaBpThread,
    shared: AokanaProcedureState,
    clock: AokanaNativeClock,
    private readonly loading: AokanaResourceLoadingState,
    private readonly service: AokanaBmvService,
    private readonly surface: number,
    private readonly movie: number,
    private readonly frame: number,
  ) {
    super(thread, shared, clock);
    loading.enterProcedure();
    this.initialize();
  }
  private initialize(): void {
    const result = this.service.start(this.surface, this.movie, this.frame);
    this.worker = result.worker;
    this.status =
      result.status === 0
        ? 0
        : result.status === 0x80000003
          ? 3
          : result.status === 0x80000005
            ? 5
            : result.status === 0x80000009
              ? 0x7fffffff
              : -1;
  }
  poll(): number {
    if (this.status < 0) return -1;
    if (this.status === 0x7fffffff) {
      this.initialize();
      return 0;
    }
    if (this.status !== 0) {
      push32(this.thread, this.status);
      return 1;
    }
    this.consumeMessages();
    if (this.worker === null) throw new Error('Aokana BMV active process has no concrete worker');
    if (!this.worker.done) return 0;
    push32(this.thread, this.worker.success ? 0 : 8);
    return 1;
  }
  override dispose(): void {
    this.worker = null;
    this.loading.leaveProcedure();
    super.dispose();
  }
}
