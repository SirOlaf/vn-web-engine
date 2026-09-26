import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  BrowserAudioContextHost,
  subscribeBrowserAudioContexts,
} from '../dist/audio/browser-audio-context-host.js';

test('audio activation recovers interrupted contexts without replacing buffers, clocks, or pending gestures', async () => {
  const document = new EventTarget();
  document.defaultView = new EventTarget();
  document.visibilityState = 'visible';
  class Context extends EventTarget {
    state = 'suspended';
    currentTime = 1.25;
    sampleRate = 48000;
    calls = 0;
    requests = [];
    resume() {
      this.calls++;
      return new Promise((resolve, reject) => this.requests.push({resolve, reject}));
    }
    change(state) {
      this.state = state;
      this.dispatchEvent(new Event('statechange'));
    }
  }
  const context = new Context(),
    changes = [],
    failures = [],
    devices = [];
  const unsubscribe = subscribeBrowserAudioContexts((hosts) => devices.push(hosts));
  const host = new BrowserAudioContextHost(
    context,
    document,
    (value) => changes.push(value),
    (error) => failures.push(error),
  );
  assert.deepEqual(devices.at(-1), [host]);
  assert.deepEqual(host.snapshot, {
    state: 'suspended',
    currentTime: 1.25,
    sampleRate: 48000,
    needsResume: true,
  });
  const initial = host.resume();
  assert.equal(context.calls, 1); // Synchronous: retain the Play gesture.
  const gesture = host.resume();
  assert.equal(context.calls, 2); // The pending first promise cannot consume the retry gesture.
  context.change('running');
  context.requests.splice(0).forEach((request) => request.resolve());
  await Promise.all([initial, gesture]);
  assert.equal(host.snapshot.needsResume, false);
  context.currentTime = 2.5;
  assert.equal(host.snapshot.currentTime, 2.5);
  document.defaultView.dispatchEvent(new Event('pageshow'));
  assert.equal(context.calls, 2); // Running contexts are left alone.

  document.visibilityState = 'hidden';
  context.change('interrupted');
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(context.calls, 2);
  assert.equal(changes.at(-1).needsResume, true);
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(context.calls, 3);
  const denied = new DOMException('Gesture required', 'NotAllowedError');
  context.requests.shift().reject(denied);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(failures, [denied]);
  assert.equal(host.snapshot.currentTime, 2.5);
  assert.equal(host.snapshot.needsResume, true);
  document.defaultView.dispatchEvent(new Event('pageshow'));
  assert.equal(context.calls, 4);
  context.change('running');
  context.requests.shift().resolve();
  await Promise.resolve();

  // Recovery must remain synchronous and usable while earlier resume requests are blocked.
  context.change('interrupted');
  document.dispatchEvent(new Event('click'));
  document.dispatchEvent(new Event('keydown'));
  assert.equal(context.calls, 6);
  assert.equal(context.currentTime, 2.5);
  context.change('running');
  context.requests.splice(0).forEach((request) => request.resolve());
  await Promise.resolve();

  context.change('closed');
  document.defaultView.dispatchEvent(new Event('pageshow'));
  assert.equal(context.calls, 6);
  assert.equal(host.snapshot.needsResume, false);
  await assert.rejects(host.resume(), {name: 'InvalidStateError'});
  host.dispose();
  assert.deepEqual(devices.at(-1), []);
  unsubscribe();
  const count = changes.length;
  context.change('suspended');
  document.dispatchEvent(new Event('visibilitychange'));
  document.defaultView.dispatchEvent(new Event('pageshow'));
  document.dispatchEvent(new Event('click'));
  document.dispatchEvent(new Event('keydown'));
  assert.equal(context.calls, 6);
  assert.equal(changes.length, count);
  await assert.rejects(host.resume(), /disposed/);
});
