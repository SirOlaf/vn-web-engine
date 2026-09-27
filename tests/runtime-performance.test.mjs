import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginRuntimeSpan,
  getRuntimePerformanceSnapshot,
  recordRuntimeMetric,
  startRuntimePerformanceRecording,
  stopRuntimePerformanceRecording,
  subscribeRuntimePerformance,
} from '../dist/platform/runtime-performance.js';

test('optional timing recorder bounds data, measures browser delays, and fully stops observation', (t) => {
  let now = 1000;
  let clockReads = 0;
  let nextTimer = 0;
  const timers = new Map();
  const observers = [];
  const statuses = [];
  const browserDocument = new EventTarget();
  browserDocument.visibilityState = 'visible';
  class Observer {
    static supportedEntryTypes = ['longtask'];
    disconnected = false;
    pending = [];
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }
    observe(options) {
      assert.deepEqual(options, {entryTypes: ['longtask']});
    }
    takeRecords() {
      return this.pending.splice(0);
    }
    disconnect() {
      this.disconnected = true;
    }
  }
  const globals = {
    document: browserDocument,
    PerformanceObserver: Observer,
    navigator: {userAgent: 'Test browser', hardwareConcurrency: 8},
  };
  const originals = new Map();
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {configurable: true, value});
  }
  t.after(() => {
    stopRuntimePerformanceRecording();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  t.mock.method(performance, 'now', () => {
    clockReads++;
    return now;
  });
  t.mock.method(globalThis, 'setInterval', (callback, interval) => {
    assert.equal(interval, 100);
    timers.set(++nextTimer, callback);
    return nextTimer;
  });
  t.mock.method(globalThis, 'clearInterval', (timer) => timers.delete(timer));

  assert.equal(beginRuntimeSpan('test.disabled'), undefined);
  recordRuntimeMetric('test.disabled', 4);
  assert.equal(clockReads, 0);
  assert.equal(timers.size, 0);
  assert.equal(observers.length, 0);
  const unsubscribe = subscribeRuntimePerformance((status) => statuses.push(status));
  startRuntimePerformanceRecording();
  startRuntimePerformanceRecording();
  assert.equal(timers.size, 1);
  assert.equal(observers.length, 1);
  assert.equal(statuses.at(-1).recording, true);

  const fast = beginRuntimeSpan('test.fast');
  now += 3;
  fast();
  fast();
  const slow = beginRuntimeSpan('test.slow', {
    bytes: 40,
    cached: false,
    path: '/private/game/secret.asset',
    text: 'private dialogue',
    invalid: Infinity,
  });
  now += 10;
  slow({primary: 0x81, secondary: 0x48, resource: 'private name'});
  const outer = beginRuntimeSpan('test.outer');
  now += 2;
  const inner = beginRuntimeSpan('test.inner', undefined, 16);
  now += 10;
  inner();
  now += 5;
  outer();
  recordRuntimeMetric('test.counter', 7);
  recordRuntimeMetric('test.counter', NaN);
  assert.equal(beginRuntimeSpan('/private/game/secret.asset'), undefined);

  now = 1200;
  [...timers.values()][0]();
  browserDocument.visibilityState = 'hidden';
  now = 1250;
  browserDocument.dispatchEvent(new Event('visibilitychange'));
  observers[0].callback({
    getEntries: () => [
      {startTime: 900, duration: 300},
      {
        startTime: 1010,
        duration: 60,
        name: 'private task name',
        attribution: [{containerSrc: '/private/game/secret.asset'}],
      },
    ],
  });
  let snapshot = getRuntimePerformanceSnapshot();
  assert.equal(snapshot.completedSpans, 4);
  assert.deepEqual(snapshot.browser, {userAgent: 'Test browser', hardwareConcurrency: 8});
  assert.equal(snapshot.aggregates.find((entry) => entry.name === 'test.fast').count, 1);
  assert.equal(
    snapshot.events.some((entry) => entry.name === 'test.fast'),
    false,
  );
  assert.deepEqual(snapshot.events.find((entry) => entry.name === 'test.slow').detail, {
    bytes: 40,
    cached: false,
    primary: 0x81,
    secondary: 0x48,
  });
  assert.equal(
    snapshot.events.some((entry) => entry.name === 'test.inner'),
    false,
  );
  assert.equal(snapshot.aggregates.find((entry) => entry.name === 'test.inner').total, 10);
  assert.equal(snapshot.events.filter((entry) => entry.kind === 'long-task').length, 1);
  assert.equal(snapshot.events.find((entry) => entry.kind === 'event-loop-delay').durationMs, 100);
  assert.equal(snapshot.events.at(-1).visibility, 'hidden');
  assert.ok(snapshot.events.every((entry, i, all) => i === 0 || entry.atMs >= all[i - 1].atMs));
  assert.doesNotMatch(JSON.stringify(snapshot), /private|secret/);
  snapshot.events.find((entry) => entry.name === 'test.slow').detail.bytes = -1;
  assert.equal(
    getRuntimePerformanceSnapshot().events.find((entry) => entry.name === 'test.slow').detail.bytes,
    40,
  );

  for (let index = 0; index < 3000; index++) {
    const finish = beginRuntimeSpan(`test.category-${index}`);
    now += 5;
    finish();
    recordRuntimeMetric(`test.metric-${index}`, 1);
  }
  snapshot = getRuntimePerformanceSnapshot();
  assert.equal(snapshot.events.length, 2048);
  assert.equal(snapshot.aggregates.length, 128);
  assert.ok(snapshot.overwrittenEvents > 0);
  assert.ok(snapshot.overflowedCategorySamples > 0);
  assert.equal(snapshot.completedSpans, 3004);
  assert.equal(
    snapshot.aggregates
      .filter((entry) => entry.kind === 'span')
      .reduce((sum, entry) => sum + entry.count, 0),
    3005,
    'all completed spans and the browser long task are aggregated despite category overflow',
  );
  assert.equal(snapshot.events.at(-1).name, 'test.category-2999');
  const unfinished = beginRuntimeSpan('test.unfinished');
  observers[0].pending.push({startTime: now - 60, duration: 60});
  stopRuntimePerformanceRecording();
  assert.equal(statuses.at(-1).recording, false);
  assert.equal(timers.size, 0);
  assert.equal(observers[0].disconnected, true);
  assert.equal(
    getRuntimePerformanceSnapshot().aggregates.find((entry) => entry.name === 'browser.long-task')
      .count,
    2,
  );
  const stopped = getRuntimePerformanceSnapshot();
  const readsAtStop = clockReads;
  now += 100;
  unfinished();
  assert.equal(beginRuntimeSpan('test.disabled'), undefined);
  recordRuntimeMetric('test.disabled', 2);
  browserDocument.dispatchEvent(new Event('visibilitychange'));
  observers[0].callback({getEntries: () => [{startTime: now, duration: 60}]});
  assert.equal(clockReads, readsAtStop);
  assert.deepEqual(getRuntimePerformanceSnapshot(), stopped);

  unsubscribe();
  const statusCount = statuses.length;
  Observer.supportedEntryTypes = [];
  startRuntimePerformanceRecording();
  unfinished();
  snapshot = getRuntimePerformanceSnapshot();
  assert.equal(snapshot.completedSpans, 0);
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.longTasksAvailable, false);
  stopRuntimePerformanceRecording();
  assert.equal(timers.size, 0);
  assert.equal(statuses.length, statusCount);
});
