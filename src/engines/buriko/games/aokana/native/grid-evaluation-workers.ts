import type {AokanaBpPointer} from '../bp/memory.js';
import type {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from './distributed-processing.js';
import {AokanaGridEvaluator} from './grid-evaluator.js';
import {gridAllocation, gridOutput, gridRead} from './logical-grid-path.js';
import type {AokanaLogicalGridManager, AokanaLogicalGridManagers} from './logical-grid.js';
import {aokanaLogicalStatus} from './logical-status.js';

type EvaluationJob =
  | {type: 0; grid: AokanaLogicalGridManager; count: number; bytes: Uint8Array}
  | {type: 1; index: number; bytes: Uint8Array; recompute: number}
  | {
      type: 2;
      output: AokanaBpPointer | null;
      count: AokanaBpPointer | null;
      index: number;
      maximum: number;
    };

class GridEvaluationThread {
  stop = false;
  busy = 0;
  status = 0;
  eventSignaled = true;
  eventClosed = false;
  started = false;
  terminated = false;
  taskPending = false;
  timer: ReturnType<typeof setTimeout> | null = null;
  job: EvaluationJob | null = null;
  failure: unknown = undefined;
  readonly changed = new Set<() => void>();
  constructor(
    readonly id: number,
    readonly evaluator: AokanaGridEvaluator,
  ) {}
  notify(): void {
    for (const notify of this.changed) notify();
    this.changed.clear();
  }
  waitForChange(): Promise<void> {
    return new Promise((resolve) => this.changed.add(resolve));
  }
}

/** 1400faee0/1400fa4c0 persistent event-driven workers, scheduled independently of VM queries. */
export class AokanaGridEvaluationWorkers {
  private nextId = 0;
  private readonly threads: GridEvaluationThread[] = [];
  private backgroundFailure: unknown = undefined;
  private finalAdmissionClosed = false;
  private finalClosing: Promise<void> | null = null;
  private finalQuiesced = false;
  constructor(
    readonly allocator: AokanaDistributedAllocator,
    readonly mainProcessing: AokanaDistributedProcessing,
    readonly grids: AokanaLogicalGridManagers,
  ) {}

  get admissionClosed(): boolean {
    return this.finalAdmissionClosed;
  }

  get quiesced(): boolean {
    return this.finalQuiesced;
  }

  private retire(thread: GridEvaluationThread): void {
    if (thread.eventClosed) return;
    thread.job = null;
    thread.busy = 0;
    thread.evaluator.dispose();
    thread.eventClosed = true;
    const index = this.threads.indexOf(thread);
    if (index >= 0) this.threads.splice(index, 1);
  }

  /** Stop host admission before the VM waits for an already admitted D0:81. */
  beginFinalClose(): void {
    if (this.finalAdmissionClosed) return;
    this.finalAdmissionClosed = true;
    for (const thread of this.threads) {
      // Native D0:81 can stop a queued worker before it accepts its job, leaving
      // busy=1 forever. Only final close drops that unaccepted, stopped job.
      if (thread.stop && thread.busy === 1) {
        thread.job = null;
        thread.busy = 0;
        thread.notify();
      }
    }
  }

  /** Drain valid work, join startup/retirement timers, then release grid/BP borrowers. */
  closeAndJoin(): Promise<void> {
    if (this.finalClosing !== null) return this.finalClosing;
    this.beginFinalClose();
    this.finalClosing = (async () => {
      let firstError = this.backgroundFailure;
      let failed = firstError !== undefined;
      let allRetired = true;
      for (const thread of [...this.threads]) {
        try {
          while (thread.busy !== 0 && !thread.terminated) await thread.waitForChange();
          thread.stop = true;
          thread.eventSignaled = true;
          this.schedule(thread);
          while (!thread.terminated || thread.taskPending || thread.timer !== null)
            await thread.waitForChange();
          this.retire(thread);
        } catch (error) {
          allRetired = false;
          if (!failed) {
            firstError = error;
            failed = true;
          }
        }
      }
      if (this.backgroundFailure !== undefined && !failed) {
        firstError = this.backgroundFailure;
        failed = true;
      }
      this.finalQuiesced = allRetired && this.threads.length === 0;
      if (!this.finalQuiesced && !failed) {
        firstError = new Error('Aokana grid evaluator workers did not quiesce');
        failed = true;
      }
      if (failed) throw firstError;
    })();
    return this.finalClosing;
  }

  hasPendingWork(): boolean {
    this.checkFailure();
    return this.threads.some((thread) => !thread.terminated && thread.busy !== 0);
  }

  /** Observe accepted jobs without changing worker admission or consuming status. */
  async joinPendingWork(): Promise<void> {
    this.checkFailure();
    await Promise.all(
      this.threads.map(async (thread) => {
        while (thread.busy !== 0 && !thread.terminated) await thread.waitForChange();
      }),
    );
    this.checkFailure();
  }
  private checkFailure(): void {
    if (this.backgroundFailure !== undefined) throw this.backgroundFailure;
  }
  private checkAdmission(): void {
    if (this.finalAdmissionClosed)
      throw new Error('Aokana grid evaluator worker admission is closed');
    this.checkFailure();
  }
  private find(id: number): GridEvaluationThread | undefined {
    this.checkAdmission();
    return this.threads.find((thread) => thread.id === id >>> 0);
  }
  private schedule(thread: GridEvaluationThread): void {
    if (thread.taskPending || thread.terminated || thread.eventClosed) return;
    thread.taskPending = true;
    thread.timer = setTimeout(() => {
      thread.timer = null;
      thread.taskPending = false;
      try {
        this.runThread(thread);
      } catch (error) {
        thread.failure = error;
        if (this.backgroundFailure === undefined) this.backgroundFailure = error;
        thread.terminated = true;
      } finally {
        thread.notify();
      }
    }, 0);
  }
  private runThread(thread: GridEvaluationThread): void {
    if (thread.eventClosed || thread.terminated || (thread.started && !thread.eventSignaled))
      return;
    thread.started = true;
    // The stop check precedes taking queued work. Destroying a queued thread can therefore leave busy=1.
    if (thread.stop) {
      thread.terminated = true;
      thread.notify();
      return;
    }
    if (thread.busy === 1) {
      thread.busy = 2;
      const job = thread.job;
      if (job === null) throw new Error('Aokana evaluator worker has no native job record');
      let status: number;
      if (job.type === 0)
        status = thread.evaluator.initialize(job.grid, job.count, {bytes: job.bytes, offset: 0});
      else if (job.type === 1)
        status = thread.evaluator.update(job.index, {bytes: job.bytes, offset: 0}, job.recompute);
      else status = thread.evaluator.evaluate(job.output, job.count, job.index, job.maximum);
      thread.status = aokanaLogicalStatus(status);
      thread.job = null;
      thread.busy = 0;
    }
    thread.eventSignaled = false;
    thread.notify();
  }
  private enqueue(thread: GridEvaluationThread, job: EvaluationJob): void {
    thread.busy = 1;
    thread.job = job;
    thread.eventSignaled = true;
    this.schedule(thread);
  }
  create(output: AokanaBpPointer | null): number {
    this.checkAdmission();
    this.nextId = (this.nextId + 1) >>> 0;
    const thread = new GridEvaluationThread(
      this.nextId,
      new AokanaGridEvaluator(this.allocator, this.mainProcessing.capacity),
    );
    this.schedule(thread);
    this.threads.unshift(thread);
    gridOutput(output, thread.id);
    return 0;
  }
  async destroy(id: number): Promise<number> {
    const thread = this.find(id);
    if (thread === undefined) return 1;
    thread.stop = true;
    while (thread.busy !== 0) {
      // A stopped worker that never accepted its queued job leaves this native wait unresolved.
      // DCSleep(1) sets a relative 5000 x 100ns timer, then performs an alertable wait.
      await new Promise<void>((resolve) => setTimeout(resolve, 0.5));
      this.checkFailure();
    }
    thread.eventSignaled = true;
    this.schedule(thread);
    while (!thread.terminated) {
      await thread.waitForChange();
      this.checkFailure();
    }
    this.retire(thread);
    return 0;
  }
  setTypeCount(id: number, value: number): number {
    const thread = this.find(id);
    if (thread === undefined) return 1;
    return thread.busy !== 0 ? 14 : aokanaLogicalStatus(thread.evaluator.setTypeCount(value));
  }
  takeStatus(output: AokanaBpPointer | null, id: number): number {
    const thread = this.find(id);
    if (thread === undefined) return 1;
    if (thread.busy !== 0) return 14;
    gridOutput(output, thread.status);
    thread.status = 0xffff0000;
    return 0;
  }
  initialize(
    id: number,
    gridId: number,
    count: number,
    input: AokanaBpPointer | null,
    asynchronous: number,
  ): number {
    const thread = this.find(id);
    if (thread === undefined) return 1;
    const grid = this.grids.get(gridId);
    if (grid === undefined) return 1;
    if (thread.busy !== 0) return 14;
    if (asynchronous === 0)
      return aokanaLogicalStatus(thread.evaluator.initialize(grid, count, input));
    const bytes = gridAllocation(count >>> 0, 1, 0x834, true);
    bytes.set(gridRead(input, bytes.length));
    this.enqueue(thread, {type: 0, grid, count: count >>> 0, bytes});
    return 0;
  }
  replaceGrid(id: number, gridId: number): number {
    const thread = this.find(id);
    if (thread === undefined) return 1;
    const grid = this.grids.get(gridId);
    if (grid === undefined) return 1;
    return thread.busy !== 0 ? 14 : aokanaLogicalStatus(thread.evaluator.replaceGrid(grid));
  }
  update(
    id: number,
    index: number,
    input: AokanaBpPointer | null,
    recompute: number,
    asynchronous: number,
  ): number {
    const thread = this.find(id);
    if (thread === undefined) return 1;
    if (thread.busy !== 0) return 14;
    if (asynchronous === 0)
      return aokanaLogicalStatus(thread.evaluator.update(index, input, recompute));
    const bytes = gridRead(input, 0x834);
    this.enqueue(thread, {type: 1, index: index >>> 0, bytes, recompute: recompute | 0});
    return 0;
  }
  evaluate(
    output: AokanaBpPointer | null,
    count: AokanaBpPointer | null,
    id: number,
    index: number,
    maximum: number,
  ): number {
    const thread = this.find(id);
    if (thread === undefined) return 1;
    if (thread.busy !== 0) return 14;
    this.enqueue(thread, {type: 2, output, count, index: index >>> 0, maximum: maximum >>> 0});
    return 0;
  }
  copyRecord(output: AokanaBpPointer | null, id: number, index: number): number {
    const thread = this.find(id);
    if (thread === undefined) return 1;
    return thread.busy !== 0 ? 14 : aokanaLogicalStatus(thread.evaluator.copyRecord(output, index));
  }
}
