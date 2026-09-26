import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BurikoMovieReferenceClock,
  BurikoMovieRenderEvents,
  burikoMovieThrottle,
} from '../dist/engines/buriko/native/movie-render-events.js';
import {BurikoMovieFilterEvents} from '../dist/engines/buriko/native/movie-filter-events.js';
import {BurikoMovieReceivePin} from '../dist/engines/buriko/native/movie-receive.js';
import {BurikoMovieRenderer} from '../dist/engines/buriko/native/movie-renderer.js';
import {
  BurikoMovieImage,
  BurikoMovieImageConfiguration,
} from '../dist/engines/buriko/native/movie-image.js';
import {BurikoNativeNotifications} from '../dist/engines/buriko/native/notification-queue.js';
import {BurikoWindowMessages} from '../dist/engines/buriko/native/window-messages.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoBitmapStorage} from '../dist/engines/buriko/native/bitmap.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

function fixture(withClock = true) {
  const surfaces = new BurikoSurfaces(
    new BurikoNativeFonts(new BurikoNativeText(), {}),
    new BurikoBitmapCompositor(),
    new BurikoDistributedAllocator(1),
  );
  const notifications = new BurikoNativeNotifications();
  const renderer = new BurikoMovieRenderer(
    surfaces,
    2,
    new BurikoMovieImage(new BurikoMovieImageConfiguration()),
    notifications,
  );
  const messages = new BurikoWindowMessages(null);
  const filterEvents = new BurikoMovieFilterEvents(messages);
  let now = 0;
  const clock = new BurikoMovieReferenceClock(() => now);
  const pin = new BurikoMovieReceivePin(renderer, filterEvents, withClock ? clock : null, clock);
  const format = new Uint8Array(88),
    view = new DataView(format.buffer);
  view.setInt32(52, 1, true);
  view.setInt32(56, -1, true);
  view.setBigInt64(40, 400000n, true);
  const type = {
    majorType: '73646976-0000-0010-8000-00aa00389b71',
    subtype: 'e436eb7e-524f-11ce-9f53-0020af0ba770',
    formatType: '05589f80-c356-11ce-bf01-00aa0055595a',
    format,
  };
  assert.equal(pin.connect(type), 0);
  const sample = (start = 0n, end = 400000n) => ({
    storage: new BurikoBitmapStorage(Uint8Array.of(1, 2, 3, 255), true),
    offset: 0,
    time: {start, end},
    discontinuity: false,
  });
  return {
    pin,
    renderer,
    surfaces,
    filterEvents,
    messages,
    sample,
    notifications,
    setNow(value) {
      now = value;
    },
  };
}

test('native renderer events retain auto/manual reset and abort priority', async () => {
  const events = new BurikoMovieRenderEvents();
  assert.equal(events.waitForState(0), 0);
  events.setReady(false);
  assert.equal(events.waitForState(0), 0x40237);
  const readyA = events.waitForState(0xffffffff),
    readyB = events.waitForState(0xffffffff);
  events.setReady(true);
  assert.deepEqual(await Promise.all([readyA, readyB]), [0, 0]);
  events.signalRender();
  events.setAbort(false);
  assert.equal(events.waitForRender(), 0x80040223);
  events.setAbort(true);
  assert.equal(events.waitForRender(), 0);
  const first = events.waitForRender(),
    second = events.waitForRender();
  events.signalRender();
  assert.equal(await first, 0);
  events.dispose();
  assert.equal(await second, 0x80040223);
});

test('clock advice cancels without a late stale signal, and throttle zero yields a task', async () => {
  let time = 0;
  const clock = new BurikoMovieReferenceClock(() => time),
    events = new BurikoMovieRenderEvents();
  events.advise(clock, 0n, 100000n);
  events.cancelNotification();
  const waiting = events.waitForRender();
  time = 20;
  await burikoMovieThrottle(20);
  events.setAbort(false);
  assert.equal(await waiting, 0x80040223);
  events.dispose();
  const order = [];
  const throttle = burikoMovieThrottle(0).then(() => order.push('task'));
  queueMicrotask(() => order.push('microtask'));
  await throttle;
  assert.deepEqual(order, ['microtask', 'task']);
});

test('paused receive primes readiness and retains the sample until Run', async () => {
  const f = fixture();
  assert.equal(f.pin.pause(), 1);
  assert.deepEqual(f.pin.getState(0), {status: 0x40237, state: 1});
  const received = f.pin.receive(f.sample());
  assert.equal(f.renderer.deliveredFrames, 0);
  assert.deepEqual(f.pin.getState(0), {status: 0, state: 1});
  assert.equal(f.pin.run(0n), 0);
  assert.equal(await received, 0);
  assert.equal(f.pin.pendingSample, null);
  assert.equal(f.renderer.deliveredFrames, 1);
  assert.equal(f.surfaces.snapshot(2).storage.view.getUint32(0, true), 0x030201);
  assert.deepEqual(f.notifications.take(), {type: 0x10000, value1: 2, value2: 0});
  f.pin.dispose();
});

test('render critical section survives Sleep and native delivered/drawn counters differ', async () => {
  const f = fixture(false);
  f.pin.run(0n);
  f.surfaces.deviceIndex = 1;
  f.pin.timing.notify(500);
  const received = f.pin.receive(f.sample());
  assert.equal(f.pin.timing.drawn, 1);
  assert.equal(f.renderer.deliveredFrames, 0);
  const paused = f.pin.pause();
  assert.equal(f.pin.state, 2);
  await received;
  assert.equal(await paused, 1);
  assert.equal(f.pin.state, 1);
  f.pin.dispose();
});

test('flush aborts a pending sample and clears EOS before EndFlush resets positions', async () => {
  const f = fixture();
  assert.equal(f.pin.endOfStream(), 0x80040227);
  f.pin.pause();
  const received = f.pin.receive(f.sample(1000000n, 1400000n));
  f.pin.endOfStream();
  await f.pin.beginFlush();
  assert.equal(await received, 0);
  assert.equal(f.pin.mediaStart, 1000000n);
  assert.equal(f.pin.receive(f.sample()), 0x80004005);
  assert.equal(f.pin.endOfStream(), 1);
  f.pin.endFlush();
  assert.equal(f.pin.mediaPositionValid, false);
  f.pin.run(0n);
  assert.equal(f.filterEvents.take(), null);
  assert.equal(await f.pin.receive(f.sample()), 0);
  assert.equal(f.renderer.deliveredFrames, 1);
  f.pin.dispose();
});

test('bad sample times drop after media-position registration and do not report stream errors', () => {
  const f = fixture();
  f.pin.run(0n);
  assert.equal(f.pin.receive(f.sample(2n, 1n)), 0);
  assert.equal(f.pin.mediaStart, 2n);
  assert.equal(f.pin.timing.dropped, 1);
  assert.equal(f.pin.runtimeError, false);
  assert.equal(f.filterEvents.take(), null);
  f.pin.dispose();
});

test('graph completions aggregate and HWND notifications preserve lifetime and parameters', () => {
  const messages = new BurikoWindowMessages(null),
    events = new BurikoMovieFilterEvents(messages);
  const a = {},
    b = {};
  events.addRenderer(a);
  events.addRenderer(b);
  assert.equal(events.setNotifyWindow('main', 0x8001, 99n), 0x80070057);
  messages.createMainTarget();
  assert.equal(events.setNotifyWindow('main', 0x8001, 99n), 0);
  assert.equal(events.setNotifyWindow(77, 0x8002, 10n), 0x80070057);
  events.notify(a, 1);
  assert.equal(events.take(), null);
  events.notify(b, 1);
  assert.deepEqual(events.take(), {code: 1, value1: 0n, value2: 0n});
  assert.deepEqual(messages.take(), {target: 'main', message: 0x8001, wParam: 0n, lParam: 99n});
  events.notify(b, 1);
  assert.equal(events.take(), null);
  events.resetCompletion();
  messages.forgetTarget('main');
  events.notify(a, 3, -1n);
  assert.deepEqual(events.take(), {code: 3, value1: -1n, value2: 0n});
  assert.equal(messages.take(), null);
});

test('EOS waits for long sample tails and pause cancels then Run reinstates its timer', async () => {
  const f = fixture();
  f.pin.sourceStopPosition = 900000n;
  f.pin.run(0n);
  await f.pin.receive(f.sample(0n, 600000n));
  f.pin.endOfStream();
  assert.equal(f.filterEvents.take(), null);
  f.pin.pause();
  await burikoMovieThrottle(75);
  assert.equal(f.filterEvents.take(), null);
  f.filterEvents.resetCompletion();
  f.pin.run(0n);
  await burikoMovieThrottle(75);
  assert.deepEqual(f.filterEvents.take(), {code: 1, value1: 0n, value2: 0n});
  assert.equal(f.pin.mediaStart, 900000n);
  assert.equal(f.pin.mediaEnd, 900000n);
  f.pin.dispose();
});
