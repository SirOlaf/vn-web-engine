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
import {BurikoSystemTicks} from '../dist/engines/buriko/native/system-ticks.js';
import {BurikoCrtRandom} from '../dist/engines/buriko/native/system-timing.js';
import {createGroup80Display} from '../dist/engines/buriko/native/group-80-display.js';
import {createPrimaryDisplayOpcodes} from '../dist/engines/buriko/bp/opcodes/display.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';

test('primary 77 reads live category counts and 80 0B reads the configured render pixel budget', () => {
  const compositor = new BurikoBitmapCompositor();
  compositor.defaultFormat = 1;
  const environment = new BurikoDisplayObjectEnvironment(
    compositor,
    new BurikoDisplayDamage(64, {left: 0, top: 0, right: 99, bottom: 99}),
  );
  const manager = new BurikoDisplayManager(
    environment,
    new BurikoSurfaces(null, compositor, {currentActor: {}}),
    new BurikoNativeDisplayState(100, 100),
  );
  const rain = new BurikoRainDisplays(
    manager,
    new BurikoRainDisplayState(),
    new BurikoCrtRandom(),
    new BurikoSystemTicks({now: () => 100}),
  );
  rain.create(8, 8);
  rain.create(8, 8);
  manager.setRenderPixelBudget(49152);
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 4,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread};
  const primary = createPrimaryDisplayOpcodes(manager);
  for (const [category, expected] of [
    [7, 2],
    [0, 0],
    [6, 0],
  ]) {
    push32(thread, category);
    assert.equal(primary[0x77](context), 0);
    assert.equal(pop32(thread), expected);
  }
  const [budget] = createGroup80Display(manager);
  assert.equal(budget.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x80][0x0b]);
  assert.equal(budget.execute(context), 0);
  assert.equal(pop32(thread), 49152);
  manager.setRenderPixelBudget(10240);
  assert.equal(budget.execute(context), 0);
  assert.equal(pop32(thread), 10240);
  assert.equal(thread.stackIndex, 0);
});
