import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoDisplayObjectEnvironment} from '../dist/engines/buriko/native/display-object.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoRainDisplayState} from '../dist/engines/buriko/native/display-rain.js';
import {BurikoRainDisplays} from '../dist/engines/buriko/native/rain-displays.js';
import {BurikoRainFrames} from '../dist/engines/buriko/native/rain-frames.js';
import {BurikoSystemTicks} from '../dist/engines/buriko/native/system-ticks.js';
import {BurikoCrtRandom} from '../dist/engines/buriko/native/system-timing.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';

function setup() {
  const compositor = new BurikoBitmapCompositor();
  compositor.defaultFormat = 1;
  const environment = new BurikoDisplayObjectEnvironment(
    compositor,
    new BurikoDisplayDamage(64, {left: 0, top: 0, right: 3, bottom: 3}),
  );
  const manager = new BurikoDisplayManager(
    environment,
    new BurikoSurfaces(null, compositor, {currentActor: {}}),
    new BurikoNativeDisplayState(1920, 1080),
  );
  let now = 0,
    reads = 0;
  const rain = new BurikoRainDisplays(
    manager,
    new BurikoRainDisplayState(),
    new BurikoCrtRandom(),
    new BurikoSystemTicks({now: () => now}),
  );
  const frames = new BurikoRainFrames(
    rain,
    new BurikoNativeClock(() => {
      reads++;
      return now;
    }),
  );
  return {rain, frames, manager, setTime: (value) => (now = value), clockReads: () => reads};
}

test('rain simulation visits real shared slots in index order independently of global visibility', () => {
  const {rain, frames, manager, clockReads} = setup();
  const seen = [];
  for (let i = 0; i < 3; i++) {
    const {handle} = rain.create(4, 4),
      object = rain.find(handle);
    object.updateRain = () => {
      seen.push(handle);
      return 0;
    };
  }
  manager.setMinimumLayer(100);
  rain.state.enabled = 0;
  frames.updateAll();
  frames.pollRefresh();
  assert.deepEqual(seen, [0xc1000000, 0xc1000001, 0xc1000002]);
  assert.equal(clockReads(), 0);
});

test('rain refresh performs one pass when due and advances its absolute deadline past missed intervals', () => {
  const {rain, frames, manager, setTime} = setup();
  let refreshes = 0;
  const {handle} = rain.create(4, 4);
  rain.find(handle).refreshRain = () => {
    refreshes++;
    return 0;
  };
  frames.pollRefresh();
  assert.equal(refreshes, 1);
  assert.equal(manager.redraw.pending, 1);
  assert.equal(manager.redraw.mode, 0);
  assert.equal(rain.state.accumulatedMilliseconds, 50);
  setTime(49);
  frames.pollRefresh();
  assert.equal(refreshes, 1);
  setTime(175);
  frames.pollRefresh();
  assert.equal(refreshes, 2);
  assert.equal(rain.state.accumulatedMilliseconds, 200);
});

test('an empty rain pool advances the refresh deadline without requesting a frame', () => {
  const {rain, frames, manager, setTime} = setup();
  setTime(120);
  frames.pollRefresh();
  assert.equal(rain.state.accumulatedMilliseconds, 150);
  assert.equal(manager.redraw.pending, 0);
});
