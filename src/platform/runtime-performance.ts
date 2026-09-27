import {subscribeRuntimeProfile, type RuntimeProfile} from './runtime-profile.js';
import {RUNTIME_BUILD_ID} from './runtime-build.js';

/** Optional, in-memory wall-clock diagnostics shared by all engines. */
const EVENT_LIMIT = 2048;
const AGGREGATE_LIMIT = 128;
const SPAN_THRESHOLD_MS = 4;
const LOOP_INTERVAL_MS = 100;
const LOOP_THRESHOLD_MS = 16;
const LABEL = /^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/;

type Detail = Readonly<Record<string, number | boolean>>;
type InputDetail = Readonly<Record<string, number | string | boolean>>;
export type RuntimeSpanEnd = (detail?: InputDetail) => void;
type Visibility = DocumentVisibilityState | 'unknown';
type AggregateKind = 'span' | 'metric';

export interface RuntimePerformanceEvent {
  readonly kind: 'span' | 'long-task' | 'event-loop-delay' | 'visibility';
  readonly name: string;
  readonly atMs: number;
  readonly durationMs?: number;
  readonly visibility: Visibility;
  readonly detail?: Detail;
}

export interface RuntimePerformanceAggregate {
  readonly kind: AggregateKind;
  readonly name: string;
  count: number;
  total: number;
  min: number;
  max: number;
}

export interface RuntimePerformanceStatus {
  readonly recording: boolean;
  readonly hasRecording: boolean;
  readonly durationMs: number;
  readonly eventCount: number;
  readonly overwrittenEvents: number;
  readonly completedSpans: number;
  readonly longTasksAvailable: boolean;
}

export interface RuntimePerformanceSnapshot extends RuntimePerformanceStatus {
  readonly schemaVersion: 1;
  readonly measurement: string;
  readonly startedAt: string | null;
  readonly buildId: string | null;
  readonly runtimeProfiles: readonly RuntimeProfile[];
  readonly browser: {
    readonly userAgent: string;
    readonly hardwareConcurrency: number | null;
  } | null;
  readonly limits: {
    readonly events: number;
    readonly aggregates: number;
    readonly spanThresholdMs: number;
    readonly eventLoopIntervalMs: number;
    readonly eventLoopThresholdMs: number;
  };
  readonly overflowedCategorySamples: number;
  readonly aggregates: readonly RuntimePerformanceAggregate[];
  readonly events: readonly RuntimePerformanceEvent[];
}

interface Recording {
  readonly startedAt: number;
  readonly startedAtDate: string;
  readonly browser: NonNullable<RuntimePerformanceSnapshot['browser']>;
  readonly events: RuntimePerformanceEvent[];
  readonly aggregates: Map<string, RuntimePerformanceAggregate>;
  readonly runtimeProfiles: Set<RuntimeProfile>;
  stoppedAt?: number;
  eventCursor: number;
  overwrittenEvents: number;
  completedSpans: number;
  overflowedCategorySamples: number;
  longTasksAvailable: boolean;
  visibility: Visibility;
  stopMonitoring?: () => void;
}

let active: Recording | undefined;
let latest: Recording | undefined;
const listeners = new Set<(status: RuntimePerformanceStatus) => void>();
const rounded = (value: number): number => Math.round(value * 100) / 100;
const visibility = (): Visibility =>
  typeof document === 'undefined' ? 'unknown' : document.visibilityState;

function details(input: Readonly<Record<string, number | string | boolean>>): Detail {
  const output: Record<string, number | boolean> = {};
  let count = 0;
  for (const key in input) {
    if (count >= 8) break;
    if (!Object.hasOwn(input, key) || !LABEL.test(key)) continue;
    const value = input[key];
    // Strings could contain asset names, paths or source text. Never retain them.
    if (typeof value !== 'boolean' && !(typeof value === 'number' && Number.isFinite(value)))
      continue;
    output[key] = value;
    count++;
  }
  return output;
}

function addEvent(recording: Recording, event: RuntimePerformanceEvent): void {
  if (recording.events.length < EVENT_LIMIT) recording.events.push(event);
  else {
    recording.events[recording.eventCursor] = event;
    recording.eventCursor = (recording.eventCursor + 1) % EVENT_LIMIT;
    recording.overwrittenEvents++;
  }
}

function aggregate(recording: Recording, kind: AggregateKind, name: string, value: number): void {
  let key = `${kind}:${name}`;
  let entry = recording.aggregates.get(key);
  if (!entry) {
    // Reserve one overflow category per kind so every valid sample is counted.
    if (recording.aggregates.size >= AGGREGATE_LIMIT - 2) {
      name = 'other';
      key = `${kind}:other`;
      entry = recording.aggregates.get(key);
      recording.overflowedCategorySamples++;
    }
    if (!entry) {
      entry = {kind, name, count: 0, total: 0, min: value, max: value};
      recording.aggregates.set(key, entry);
    }
  }
  entry.count++;
  entry.total += value;
  entry.min = Math.min(entry.min, value);
  entry.max = Math.max(entry.max, value);
}

/**
 * Names and detail keys must be fixed technical labels, never game data.
 * Disabled calls allocate nothing and do not read the clock. String details are discarded.
 * Durations include asynchronous waits and overlapping spans; they are not CPU samples.
 * Supply detail to the end callback when it is known only after the operation. Optional
 * chaining then avoids constructing that detail while disabled. Higher event thresholds
 * suppress routine envelope events without dropping their aggregate measurements.
 */
export function beginRuntimeSpan(
  name: string,
  detail?: InputDetail,
  eventThresholdMs = SPAN_THRESHOLD_MS,
): RuntimeSpanEnd | undefined {
  const recording = active;
  if (!recording || !LABEL.test(name)) return undefined;
  const startedAt = performance.now();
  const capturedDetail = detail ? details(detail) : undefined;
  const startedVisibility = recording.visibility;
  let finished = false;
  return (endDetail) => {
    if (finished || active !== recording) return;
    finished = true;
    const duration = Math.max(0, performance.now() - startedAt);
    recording.completedSpans++;
    aggregate(recording, 'span', name, duration);
    if (duration < Math.max(SPAN_THRESHOLD_MS, eventThresholdMs)) return;
    const eventDetail = endDetail ? details({...capturedDetail, ...endDetail}) : capturedDetail;
    addEvent(recording, {
      kind: 'span',
      name,
      atMs: rounded(startedAt - recording.startedAt),
      durationMs: rounded(duration),
      visibility: startedVisibility,
      ...(eventDetail && Object.keys(eventDetail).length ? {detail: eventDetail} : {}),
    });
  };
}

/** Aggregate finite numeric samples only; metric names define their units. */
export function recordRuntimeMetric(name: string, value: number): void {
  const recording = active;
  if (!recording || !LABEL.test(name) || !Number.isFinite(value)) return;
  aggregate(recording, 'metric', name, value);
}

export function getRuntimePerformanceStatus(): RuntimePerformanceStatus {
  return {
    recording: !!active,
    hasRecording: !!latest,
    durationMs: latest ? rounded((latest.stoppedAt ?? performance.now()) - latest.startedAt) : 0,
    eventCount: latest?.events.length ?? 0,
    overwrittenEvents: latest?.overwrittenEvents ?? 0,
    completedSpans: latest?.completedSpans ?? 0,
    longTasksAvailable: latest?.longTasksAvailable ?? false,
  };
}

function publish(): void {
  const status = getRuntimePerformanceStatus();
  for (const listener of listeners) {
    try {
      listener(status);
    } catch {
      /* Diagnostic observers never interrupt gameplay. */
    }
  }
}

export function subscribeRuntimePerformance(
  listener: (status: RuntimePerformanceStatus) => void,
): () => void {
  listeners.add(listener);
  try {
    listener(getRuntimePerformanceStatus());
  } catch {
    /* Diagnostic observers never interrupt gameplay. */
  }
  return () => listeners.delete(listener);
}

/** Start a fresh recording. Calling this while recording is a no-op. */
export function startRuntimePerformanceRecording(): void {
  if (active) return;
  const startedAt = performance.now();
  const recording: Recording = {
    startedAt,
    startedAtDate: new Date().toISOString(),
    browser: {
      userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent.slice(0, 512),
      hardwareConcurrency:
        typeof navigator !== 'undefined' && Number.isFinite(navigator.hardwareConcurrency)
          ? navigator.hardwareConcurrency
          : null,
    },
    events: [],
    aggregates: new Map(),
    runtimeProfiles: new Set(),
    eventCursor: 0,
    overwrittenEvents: 0,
    completedSpans: 0,
    overflowedCategorySamples: 0,
    longTasksAvailable: false,
    visibility: visibility(),
  };
  active = latest = recording;
  const unsubscribeProfile = subscribeRuntimeProfile((profile) => {
    recording.runtimeProfiles.add(profile);
  });
  const onVisibility = () => {
    recording.visibility = visibility();
    addEvent(recording, {
      kind: 'visibility',
      name: 'browser.visibility',
      atMs: rounded(performance.now() - startedAt),
      visibility: recording.visibility,
    });
  };
  onVisibility();
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);

  let observer: PerformanceObserver | undefined;
  const acceptLongTasks = (entries: readonly PerformanceEntry[]) => {
    if (active !== recording) return;
    for (const entry of entries) {
      if (entry.startTime < startedAt || !Number.isFinite(entry.duration) || entry.duration < 0)
        continue;
      aggregate(recording, 'span', 'browser.long-task', entry.duration);
      addEvent(recording, {
        kind: 'long-task',
        name: 'browser.long-task',
        atMs: rounded(entry.startTime - startedAt),
        durationMs: rounded(entry.duration),
        visibility: recording.visibility,
      });
    }
  };
  if (
    typeof PerformanceObserver !== 'undefined' &&
    PerformanceObserver.supportedEntryTypes?.includes('longtask')
  ) {
    try {
      observer = new PerformanceObserver((list) => acceptLongTasks(list.getEntries()));
      observer.observe({entryTypes: ['longtask']});
      recording.longTasksAvailable = true;
    } catch {
      observer?.disconnect();
      observer = undefined;
    }
  }

  let expectedAt = startedAt + LOOP_INTERVAL_MS;
  let lastPublishedAt = startedAt;
  const timer = setInterval(() => {
    if (active !== recording) return;
    const now = performance.now();
    const delay = Math.max(0, now - expectedAt);
    aggregate(recording, 'metric', 'browser.event-loop-delay-ms', delay);
    if (delay >= LOOP_THRESHOLD_MS) {
      addEvent(recording, {
        kind: 'event-loop-delay',
        name: 'browser.event-loop-delay',
        atMs: rounded(expectedAt - startedAt),
        durationMs: rounded(delay),
        visibility: recording.visibility,
      });
    }
    expectedAt = now + LOOP_INTERVAL_MS;
    if (now - lastPublishedAt >= 1000) {
      lastPublishedAt = now;
      publish();
    }
  }, LOOP_INTERVAL_MS);
  recording.stopMonitoring = () => {
    unsubscribeProfile();
    clearInterval(timer);
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', onVisibility);
    if (observer) {
      acceptLongTasks(observer.takeRecords());
      observer.disconnect();
    }
  };
  publish();
}

export function stopRuntimePerformanceRecording(): void {
  if (!active) return;
  active.stoppedAt = performance.now();
  active.stopMonitoring?.();
  active.stopMonitoring = undefined;
  active = undefined;
  publish();
}

/** Detached, bounded JSON data. Does not read resources, paths, stacks or attribution. */
export function getRuntimePerformanceSnapshot(): RuntimePerformanceSnapshot {
  return {
    schemaVersion: 1,
    measurement:
      'Wall-clock timings, not CPU attribution. Spans may overlap and include asynchronous waits. ' +
      'Event-loop delays may include browser scheduling and background-tab throttling. ' +
      'Span aggregate totals/min/max are milliseconds; metric units are defined by their names. ' +
      'Events retain the most recent completed slow operations; aggregates cover the full recording.',
    ...getRuntimePerformanceStatus(),
    startedAt: latest?.startedAtDate ?? null,
    buildId: RUNTIME_BUILD_ID,
    runtimeProfiles: latest ? [...latest.runtimeProfiles] : [],
    browser: latest ? {...latest.browser} : null,
    limits: {
      events: EVENT_LIMIT,
      aggregates: AGGREGATE_LIMIT,
      spanThresholdMs: SPAN_THRESHOLD_MS,
      eventLoopIntervalMs: LOOP_INTERVAL_MS,
      eventLoopThresholdMs: LOOP_THRESHOLD_MS,
    },
    overflowedCategorySamples: latest?.overflowedCategorySamples ?? 0,
    aggregates: latest
      ? [...latest.aggregates.values()].map((entry) => ({
          ...entry,
          total: rounded(entry.total),
          min: rounded(entry.min),
          max: rounded(entry.max),
        }))
      : [],
    events: latest
      ? [...latest.events.slice(latest.eventCursor), ...latest.events.slice(0, latest.eventCursor)]
          .map((event) => ({...event, ...(event.detail ? {detail: {...event.detail}} : {})}))
          .sort((a, b) => a.atMs - b.atMs)
      : [],
  };
}
