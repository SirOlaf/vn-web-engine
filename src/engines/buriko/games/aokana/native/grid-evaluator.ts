import type {AokanaBpPointer} from '../bp/memory.js';
import {AokanaDistributedProcessing} from './distributed-processing.js';
import type {AokanaDistributedAllocator} from './distributed-processing.js';
import {AokanaGridEvaluatorRecords} from './grid-evaluator-records.js';
import {prepareGridEvaluation} from './grid-evaluator-jobs.js';
import type {AokanaGridEvaluationCandidates} from './grid-evaluator-jobs.js';
import {simulateGridEvaluation} from './grid-evaluator-simulation.js';
import {gridAllocation, gridCopy, gridOutput} from './logical-grid-path.js';
import type {AokanaLogicalGridManager} from './logical-grid.js';
import {nativeQuickSort} from './record-sort.js';

/** DCTESLGEvaluator, 1400a8ff0, with its dedicated complete distributed work pool. */
export class AokanaGridEvaluator extends AokanaGridEvaluatorRecords {
  private readonly pool: AokanaDistributedProcessing;
  private readonly workerGrids: (AokanaLogicalGridManager | null)[];
  private candidates: AokanaGridEvaluationCandidates | null = null;
  private selected = 0;
  private cursor = 0;

  constructor(allocator: AokanaDistributedAllocator, capacity: number) {
    super();
    this.pool = new AokanaDistributedProcessing(allocator, capacity);
    this.pool.setWorkerCallback((context, worker) => context.work(worker), this);
    this.workerGrids = Array(capacity >>> 0).fill(null);
  }

  dispose(): void {
    this.clear();
    this.pool.setWorkerCallback(null, null);
    this.pool.dispose();
  }

  private work(worker: number): number {
    const lock = this.pool.enterShared(),
      candidates = this.candidates;
    if (candidates === null)
      throw new Error('Aokana grid evaluator worker uses released candidates');
    const index = this.cursor;
    if (index < candidates.jobs.length) this.cursor = (index + 1) >>> 0;
    this.pool.leaveShared(lock);
    if (index >= candidates.jobs.length) return 0;
    const grid = this.workerGrids[worker >>> 0];
    if (grid == null) throw new Error('Aokana grid evaluator worker dereferences null copied grid');
    simulateGridEvaluation(
      this,
      grid,
      this.selected,
      candidates.jobs.job(index),
      candidates.turnOrder,
    );
    return 1;
  }

  /** 1400a7c90 ranks all six native score slots with the subtracting descending CRT comparator. */
  evaluate(
    output: AokanaBpPointer | null,
    count: AokanaBpPointer | null,
    index: number,
    maximum: number,
  ): number {
    index >>>= 0;
    maximum >>>= 0;
    if (index >= this.records.length) return 0x90000003;
    this.selected = index;
    const candidates = prepareGridEvaluation(this, index);
    this.candidates = candidates;
    this.cursor = 0;
    for (let i = 0; i < this.workerGrids.length; i++)
      this.workerGrids[i] = this.requireGrid().clone();
    this.pool.run(1);
    for (const grid of this.workerGrids) grid?.dispose();
    let total = 0;
    for (let i = 0; i < candidates.jobs.length; i++) {
      const job = candidates.jobs.job(i);
      for (let direction = 0; direction < 6; direction++)
        if (job.getInt32(0x34 + direction * 4, true) !== -0x80000000) total = (total + 1) >>> 0;
    }
    if (total !== 0) {
      const bytes = gridAllocation(total, 1, 28, true),
        view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        order: number[] = [];
      gridAllocation(total, 1, 8, true);
      let cursor = 0;
      for (let i = 0; i < candidates.jobs.length; i++) {
        const job = candidates.jobs.job(i);
        for (let direction = 0; direction < 6; direction++) {
          const score = job.getInt32(0x34 + direction * 4, true);
          if (score === -0x80000000) continue;
          for (let word = 0; word < 7; word++)
            view.setInt32(cursor * 28 + word * 4, job.getInt32(word * 4, true), true);
          let bonus = 0;
          if (job.getInt32(8, true) === 0) {
            view.setInt32(cursor * 28 + 8, direction, true);
            if (job.getInt32(28, true) === direction) bonus = 2;
            if (job.getInt32(32, true) === direction) bonus = 1;
          }
          view.setInt32(cursor * 28 + 24, (score + bonus) | 0, true);
          order.push(cursor++);
        }
      }
      nativeQuickSort(
        total,
        (left, right) =>
          (view.getInt32(order[right]! * 28 + 24, true) -
            view.getInt32(order[left]! * 28 + 24, true)) |
          0,
        (left, right) => {
          const old = order[left]!;
          order[left] = order[right]!;
          order[right] = old;
        },
      );
      for (let i = 0; i < total && i < maximum; i++) {
        gridCopy(
          output === null ? null : {bytes: output.bytes, offset: output.offset + i * 28},
          bytes.subarray(order[i]! * 28, order[i]! * 28 + 28),
        );
      }
    }
    this.candidates = null;
    gridOutput(count, Math.min(maximum, total));
    return 0;
  }
}
