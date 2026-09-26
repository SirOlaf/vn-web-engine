export interface SourceActivity {
  readonly pending: number;
  readonly pendingLocal: number;
  readonly pendingRemote: number;
  readonly receivedBytes: number;
  readonly readBytes: number;
  readonly oldestStartedAt: number | null;
}
const reads = new Map<object, {kind: 'local' | 'remote'; startedAt: number}>();
let receivedBytes = 0;
let readBytes = 0;
const listeners = new Set<(activity: SourceActivity) => void>();
function snapshot(): SourceActivity {
  let pendingLocal = 0,
    pendingRemote = 0,
    oldestStartedAt: number | null = null;
  for (const {kind, startedAt} of reads.values()) {
    if (kind === 'local') pendingLocal++;
    else pendingRemote++;
    oldestStartedAt = oldestStartedAt === null ? startedAt : Math.min(oldestStartedAt, startedAt);
  }
  return {
    pending: reads.size,
    pendingLocal,
    pendingRemote,
    receivedBytes,
    readBytes,
    oldestStartedAt,
  };
}
function publish(): void {
  const current = snapshot();
  for (const listener of listeners) {
    try {
      listener(current);
    } catch {
      /* Observers do not own I/O. */
    }
  }
}
/** Reports actual reads, without changing native load ordering or readiness. */
function beginRead(kind: 'local' | 'remote'): (bytes: number) => void {
  const key = {};
  reads.set(key, {kind, startedAt: performance.now()});
  publish();
  return (bytes) => {
    if (!reads.delete(key)) return;
    if (kind === 'local') readBytes += bytes;
    else receivedBytes += bytes;
    publish();
  };
}
export function beginRemoteRead(): (bytes: number) => void {
  return beginRead('remote');
}
export function beginLocalRead(): (bytes: number) => void {
  return beginRead('local');
}
export function subscribeSourceActivity(listener: (activity: SourceActivity) => void): () => void {
  listeners.add(listener);
  listener(snapshot());
  return () => {
    listeners.delete(listener);
  };
}
