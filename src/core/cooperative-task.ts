import {HostTaskBudget} from './host-task-budget.js';
import {beginRuntimeSpan} from '../platform/runtime-performance.js';

/** A computation yields only at points where its live state can safely resume. */
export type CooperativeTask<T> = Generator<void, T, void>;

/** Synchronous callers use the same computation without host scheduling points. */
export function finishTask<T>(task: CooperativeTask<T>): T {
  for (;;) {
    const step = task.next();
    if (step.done) return step.value;
  }
}

/** Run bounded computation steps in shared host-budget slices.
 * A resolved Promise alone cannot service timers, input, or audio refill messages.
 * beforeResume lets the owner validate borrowed storage after every host yield. */
export async function runCooperativeTask<T>(
  task: CooperativeTask<T>,
  beforeResume: () => void = () => {},
  budget = new HostTaskBudget(),
): Promise<T> {
  let finishTiming = beginRuntimeSpan('host.cooperative.slice');
  try {
    beforeResume();
    for (;;) {
      const step = task.next();
      if (step.done) return step.value;
      const pending = budget.checkpoint();
      if (pending !== undefined) {
        finishTiming?.();
        finishTiming = undefined;
        await pending;
        finishTiming = beginRuntimeSpan('host.cooperative.slice');
        beforeResume();
      }
    }
  } finally {
    finishTiming?.();
    // Release generator-owned state if the owner rejects a resumed borrow.
    task.return(undefined as T);
  }
}
