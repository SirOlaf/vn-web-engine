import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoTraditionalMovieAudioPolicy} from '../dist/engines/buriko/native/movie-traditional-audio-policy.js';

test('traditional fullscreen movie policy retains exact volume and raw suppression without a graph', () => {
  const policy = new BurikoTraditionalMovieAudioPolicy();
  assert.equal(policy.savedDecibels, 0);
  assert.equal(policy.rawSuppression, 0);

  for (const [volume, decibels] of [
    [0, -10000],
    [1, -4762],
    [64, -2400],
    [127, -37],
    [128, 0],
  ]) {
    assert.equal(policy.setVolume(volume), true);
    assert.equal(policy.savedDecibels, decibels);
  }
  assert.equal(policy.setVolume(129), false);
  assert.equal(policy.savedDecibels, 0);

  assert.equal(policy.setSuppression(1), 0);
  assert.equal(policy.rawSuppression, 1);
  assert.equal(policy.setSuppression(2), 1);
  assert.equal(policy.rawSuppression, 1); // Native skips nonzero-to-nonzero updates.
  assert.equal(policy.setVolume(64), true);
  assert.equal(policy.savedDecibels, -2400);
  assert.equal(policy.setSuppression(0), 1);
  assert.equal(policy.rawSuppression, 0);
  assert.equal(policy.setSuppression(0), 0);

  assert.equal(policy.setSuppression(0x80000000), 0);
  assert.equal(policy.rawSuppression, -0x80000000);
  assert.equal(policy.setSuppression(1), -0x80000000);
  assert.equal(policy.rawSuppression, -0x80000000);
  assert.equal(policy.setSuppression(0), -0x80000000);
  assert.equal(policy.rawSuppression, 0);
  assert.equal(policy.savedDecibels, -2400);
});
