import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaMovieFilterEvents} from '../dist/engines/buriko/games/aokana/native/movie-filter-events.js';
import {AokanaWindowMessages} from '../dist/engines/buriko/games/aokana/native/window-messages.js';
import {AokanaNativeInput} from '../dist/engines/buriko/games/aokana/native/input.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';

test('actual movie event readiness follows window publication and both renderer completions', () => {
  const messages = new AokanaWindowMessages(
      new AokanaNativeInput(new AokanaNativeDisplayState(640, 480), new AokanaNativeClock(() => 0)),
    ),
    target = messages.createMainTarget(),
    events = new AokanaMovieFilterEvents(messages),
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
