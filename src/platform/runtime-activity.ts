export interface RuntimeActivity {
  readonly label: string;
  readonly startedAt: number;
}
const activities = new Set<RuntimeActivity>();
const listeners = new Set<(activities: readonly RuntimeActivity[]) => void>();
function publish(): void {
  const current = [...activities];
  for (const listener of listeners) {
    try {
      listener(current);
    } catch {
      /* Observers never own the pending operation. */
    }
  }
}
/** Browser work that may otherwise look like a frozen native canvas. Observation only. */
export function beginRuntimeActivity(label: string): () => void {
  const activity = {label, startedAt: performance.now()};
  activities.add(activity);
  publish();
  return () => {
    if (activities.delete(activity)) publish();
  };
}
export function subscribeRuntimeActivity(
  listener: (activities: readonly RuntimeActivity[]) => void,
): () => void {
  listeners.add(listener);
  try {
    listener([...activities]);
  } catch {
    /* Observers never own the pending operation. */
  }
  return () => {
    listeners.delete(listener);
  };
}
