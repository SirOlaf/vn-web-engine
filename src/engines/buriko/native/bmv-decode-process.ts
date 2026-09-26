import {push32, type BurikoBpThread} from '../bp/state.js';
import {BurikoProcedure, type BurikoProcedureState} from './procedure.js';
import type {BurikoNativeClock} from './clock.js';
import type {BurikoResourceLoadingState} from './resource-loading.js';
import type {BurikoBmvService, BurikoBmvWorker} from './bmv-service.js';

/** DCProcDecodeBMV 09B240/09B0B0/09B150/09B1F0. */
export class BurikoBmvDecodeProcess extends BurikoProcedure {
  private status = 0;
  private worker: BurikoBmvWorker | null = null;
  constructor(
    thread: BurikoBpThread,
    shared: BurikoProcedureState,
    clock: BurikoNativeClock,
    private readonly loading: BurikoResourceLoadingState,
    private readonly service: BurikoBmvService,
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
    if (this.worker === null) throw new Error('Buriko BMV active process has no concrete worker');
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
