export interface RuntimeActivity {
  readonly label: string;
  readonly startedAt: number;
  /** Completed and total work units, for activities that report progress. */
  readonly progress?: {readonly done: number; readonly total: number};
  /** Shown even when the player hides general loading feedback. */
  readonly essential?: boolean;
}
export interface RuntimeActivityOptions {
  /** Enables progress reporting through the returned `advance`. */
  readonly total?: number;
  readonly essential?: boolean;
}
/** Ends the activity; `advance` reports completed work units. */
export interface RuntimeActivityEnd {
  (): void;
  advance(count?: number): void;
}
/** Keyed by a per-activity token so progress updates keep the original order. */
const activities = new Map<object, RuntimeActivity>();
const listeners = new Set<(activities: readonly RuntimeActivity[]) => void>();
function publish(): void {
  const current = [...activities.values()];
  for (const listener of listeners) {
    try {
      listener(current);
    } catch {
      /* Observers never own the pending operation. */
    }
  }
}
/** Browser work that may otherwise look like a frozen native canvas. Observation only. */
export function beginRuntimeActivity(
  label: string,
  options: RuntimeActivityOptions = {},
): RuntimeActivityEnd {
  // Snapshots handed to observers are immutable; progress replaces the entry.
  let activity: RuntimeActivity = {
    label,
    startedAt: performance.now(),
    ...(options.total === undefined ? {} : {progress: {done: 0, total: options.total}}),
    ...(options.essential ? {essential: true} : {}),
  };
  const key = {};
  activities.set(key, activity);
  publish();
  const finish = (() => {
    if (activities.delete(key)) publish();
  }) as RuntimeActivityEnd;
  finish.advance = (count = 1) => {
    const progress = activity.progress;
    if (!progress || !activities.has(key)) return;
    activity = {
      ...activity,
      progress: {done: Math.min(progress.total, progress.done + count), total: progress.total},
    };
    activities.set(key, activity);
    publish();
  };
  return finish;
}
export function subscribeRuntimeActivity(
  listener: (activities: readonly RuntimeActivity[]) => void,
): () => void {
  listeners.add(listener);
  try {
    listener([...activities.values()]);
  } catch {
    /* Observers never own the pending operation. */
  }
  return () => {
    listeners.delete(listener);
  };
}
