import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoMovieFilterEvents} from '../dist/engines/buriko/native/movie-filter-events.js';
import {BurikoWindowMessages} from '../dist/engines/buriko/native/window-messages.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';

test('actual movie event readiness follows window publication and both renderer completions', () => {
  const messages = new BurikoWindowMessages(
      new BurikoNativeInput(new BurikoNativeDisplayState(640, 480), new BurikoNativeClock(() => 0)),
    ),
    target = messages.createMainTarget(),
    events = new BurikoMovieFilterEvents(messages),
    video = {},
    audio = {},
    readiness = [];
  events.addRenderer(video);
  events.addRenderer(audio);
  assert.equal(events.setNotifyWindow(target, 0x8000, 7n), 0);
  const remove = events.onAvailable(() => readiness.push(messages.pending));
  try {
    events.notify(video, 1);
    assert.deepEqual(readiness, []);
    assert.equal(events.take(), null);
    events.notify(audio, 1);
    assert.deepEqual(readiness, [1]);
    let readyAtSubscription = 0;
    const removeLate = events.onAvailable(() => readyAtSubscription++);
    assert.equal(readyAtSubscription, 1);
    removeLate();
    assert.deepEqual(events.take(), {code: 1, value1: 0n, value2: 0n});
    assert.deepEqual(messages.take(), {target, message: 0x8000, wParam: 0n, lParam: 7n});
    assert.equal(events.take(), null);
    // A joined new epoch resets both real renderer memberships after draining.
    events.resetCompletion();
    events.notify(audio, 1);
    assert.deepEqual(readiness, [1]);
    events.notify(video, 1);
    assert.deepEqual(readiness, [1, 1]);
    assert.deepEqual(events.take(), {code: 1, value1: 0n, value2: 0n});
    assert.deepEqual(messages.take(), {target, message: 0x8000, wParam: 0n, lParam: 7n});
    assert.equal(messages.pending, 0);
  } finally {
    remove();
    events.removeRenderer(video);
    events.removeRenderer(audio);
    events.dispose();
  }
});
