/** Bounded sequential engine ticks. Presentation may use the last result; ticks never skip. */
export async function frameBatch<T>(
  step: () => Promise<T>,
  options: {frames: number; milliseconds: number; active(): boolean; now(): number},
): Promise<T | undefined> {
  const began = options.now();
  let last: T | undefined;
  for (let i = 0; i < options.frames && options.active(); i++) {
    const result = await step();
    if (!options.active()) return undefined;
    last = result;
    if (options.now() - began >= options.milliseconds) break;
  }
  return last;
}
