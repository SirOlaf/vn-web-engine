import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaRainDisplayState} from '../dist/engines/buriko/games/aokana/native/display-rain.js';
import {AokanaRainDisplays} from '../dist/engines/buriko/games/aokana/native/rain-displays.js';
import {AokanaSystemTicks} from '../dist/engines/buriko/games/aokana/native/system-ticks.js';
import {AokanaCrtRandom} from '../dist/engines/buriko/games/aokana/native/system-timing.js';
import {createGroup80Display} from '../dist/engines/buriko/games/aokana/native/group-80-display.js';
import {createPrimaryDisplayOpcodes} from '../dist/engines/buriko/games/aokana/bp/opcodes/display.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';

test('primary 77 reads live category counts and 80 0B reads the configured render pixel budget', () => {
  const compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 1;
  const environment = new AokanaDisplayObjectEnvironment(
    compositor,
    new AokanaDisplayDamage(64, {left: 0, top: 0, right: 99, bottom: 99}),
  );
  const manager = new AokanaDisplayManager(
    environment,
    new AokanaSurfaces(null, compositor, {currentActor: {}}),
    new AokanaNativeDisplayState(100, 100),
  );
  const rain = new AokanaRainDisplays(
    manager,
    new AokanaRainDisplayState(),
    new AokanaCrtRandom(),
    new AokanaSystemTicks({now: () => 100}),
  );
  rain.create(8, 8);
  rain.create(8, 8);
  manager.setRenderPixelBudget(49152);
  const thread = new AokanaBpThread({
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
  assert.equal(budget.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x80][0x0b]);
  assert.equal(budget.execute(context), 0);
  assert.equal(pop32(thread), 49152);
  manager.setRenderPixelBudget(10240);
  assert.equal(budget.execute(context), 0);
  assert.equal(pop32(thread), 10240);
  assert.equal(thread.stackIndex, 0);
});
