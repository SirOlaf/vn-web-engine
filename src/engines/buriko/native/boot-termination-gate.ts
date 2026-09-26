import {BurikoBpScheduler, type BurikoBpSchedulerResult} from '../bp/scheduler.js';
import {BurikoResourceLoadingState} from './resource-loading.js';

/** ECB90's two latches and its live 7E970 retirement gate.
 * The owner does not run the scheduler, pump messages, or retire any child.
 */
export class BurikoBootTerminationGate {
  private termination = false;
  private restart = true;
  private awaitingBoot = false;
  private booted = false;

  constructor(
    readonly scheduler: BurikoBpScheduler,
    readonly loading: BurikoResourceLoadingState,
  ) {
    if (
      !(scheduler instanceof BurikoBpScheduler) ||
      !(loading instanceof BurikoResourceLoadingState)
    )
      throw new TypeError(
        'Buriko boot gate requires the actual scheduler and resource loading owners',
      );
  }

  get terminationRequested(): boolean {
    return this.termination;
  }
  get restartRequested(): boolean {
    return this.restart;
  }

  /** Clear R15 before the caller performs the full reset and snapshots BC250 names. */
  beginOuterReset(): boolean {
    if (!this.restart) return false;
    if (
      this.awaitingBoot ||
      (this.booted && !this.canRetireChildren) ||
      this.scheduler.firstThread !== null
    )
      throw new Error('Buriko outer reset requires a retired root child chain');
    this.restart = false;
    this.awaitingBoot = true;
    return true;
  }

  /** ED070 follows only a nonzero ED170 return for a linked, attached child. */
  beginSuccessfulBoot(childId: number): void {
    const node =
      Number.isSafeInteger(childId) && childId > 0 && childId <= 0xffffffff
        ? this.scheduler.findById(childId)
        : null;
    if (
      !this.awaitingBoot ||
      node === null ||
      node === this.scheduler.root ||
      node.state.disposed ||
      node.state.modules.length === 0
    )
      throw new Error('Buriko successful boot requires the linked ED170 child');
    this.awaitingBoot = false;
    this.booted = true;
    this.termination = false;
  }

  /** Scheduler result 1 exits; result 2 also retains the restart latch. */
  observeSchedulerResult(result: BurikoBpSchedulerResult): void {
    if (!this.booted || this.awaitingBoot || (result !== 0 && result !== 1 && result !== 2))
      throw new Error('Buriko boot gate requires a live normal scheduler result');
    if (result === 1 || result === 2) this.termination = true;
    if (result === 2) this.restart = true;
  }

  /** A negative 100860 pump result requests exit without changing restart. */
  observePumpResult(result: number): void {
    if (!this.booted || this.awaitingBoot || !Number.isSafeInteger(result))
      throw new Error('Buriko boot gate requires a live GUI pump result');
    if (result < 0) this.termination = true;
  }

  /** Read the live load/encode procedure count after the entire outer tick. */
  get canRetireChildren(): boolean {
    return (
      this.booted && !this.awaitingBoot && this.termination && this.loading.activeProcedures === 0
    );
  }
}
