import assert from 'node:assert/strict';
import test from 'node:test';
import {BurikoEngineInitializedState} from '../dist/engines/buriko/native/engine-initialized-state.js';

test('engine lifecycle bit separates grouped startup return from final publication and clears at teardown ingress', () => {
  const events = [];
  const state = new BurikoEngineInitializedState();
  assert.equal(state.initialized, false);

  assert.equal(
    state.completeStartup(1, () => {
      events.push('final-condition');
      return 1;
    }),
    1,
  );
  assert.deepEqual(events, ['final-condition']);
  assert.equal(state.initialized, true);

  assert.equal(
    state.completeStartup(1, () => 0),
    1,
  );
  assert.equal(state.initialized, false);

  state.clearAtTeardownIngress();
  events.push('later-cleanup');
  assert.equal(state.initialized, false);
  assert.deepEqual(events, ['final-condition', 'later-cleanup']);

  assert.equal(
    state.completeStartup(1, () => 0),
    1,
  );
  assert.equal(state.initialized, false);
  state.clearAtTeardownIngress();

  assert.equal(
    state.completeStartup(0, () => {
      events.push('unexpected-final-condition');
      return 1;
    }),
    0,
  );
  assert.equal(state.initialized, false);
  assert.equal(events.includes('unexpected-final-condition'), false);
});
