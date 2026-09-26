/** A computation yields only at points where its live state can safely resume. */
export type CooperativeTask<T> = Generator<void, T, void>;

/** Synchronous callers use the same computation without host scheduling points. */
export function finishTask<T>(task: CooperativeTask<T>): T {
  for (;;) {
    const step = task.next();
    if (step.done) return step.value;
  }
}

/** Run bounded computation steps in 8ms slices, leaving host tasks time to run.
 * A resolved Promise alone cannot service timers, input, or audio refill messages.
 * beforeResume lets the owner validate borrowed storage after every host yield. */
export async function runCooperativeTask<T>(
  task: CooperativeTask<T>,
  beforeResume: () => void = () => {},
): Promise<T> {
  try {
    for (;;) {
      beforeResume();
      const deadline = performance.now() + 8;
      do {
        const step = task.next();
        if (step.done) return step.value;
      } while (performance.now() < deadline);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    // Release generator-owned state if the owner rejects a resumed borrow.
    task.return(undefined as T);
  }
}
