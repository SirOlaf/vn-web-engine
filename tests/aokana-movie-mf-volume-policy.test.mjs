import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoFullscreenMovieState} from '../dist/engines/buriko/native/movie-fullscreen-state.js';
import {BurikoMfMovieVolumePolicy} from '../dist/engines/buriko/native/movie-mf-volume-policy.js';

test('MF volume policy preserves initialized saved state when no controller is present', () => {
  const fullscreen = new BurikoFullscreenMovieState(),
    policy = new BurikoMfMovieVolumePolicy(fullscreen);
  assert.equal(policy.fullscreen, fullscreen);
  assert.equal(fullscreen.controller, null);
  assert.equal(policy.savedVolume, 0);
  assert.equal(policy.applyVolume(88, 1), 0x80000002);
  assert.equal(policy.savedVolume, 0);
  policy.applyWindowSuppression(1);
  assert.equal(policy.savedVolume, 0);
  policy.applyWindowSuppression(0);
  assert.equal(policy.savedVolume, 0);
  assert.equal(fullscreen.query(), 0x80000002);
});
