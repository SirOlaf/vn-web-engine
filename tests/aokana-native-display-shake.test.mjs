import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpScheduler} from '../dist/engines/buriko/games/aokana/bp/scheduler.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {createGroup90DisplayShake} from '../dist/engines/buriko/games/aokana/native/group-90-display-shake.js';
import {AokanaNativeInput} from '../dist/engines/buriko/games/aokana/native/input.js';
import {AokanaProcedureState} from '../dist/engines/buriko/games/aokana/native/procedure.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

test('object shake schedules all six triangular modes, decay, catch-up and shared completion', async () => {
  let tick = 0;
  const clock = new AokanaNativeClock(() => tick),
    text = new AokanaNativeText(),
    fonts = new AokanaNativeFonts(text),
    compositor = new AokanaBitmapCompositor(),
    allocator = new AokanaDistributedAllocator(1),
    surfaces = new AokanaSurfaces(fonts, compositor, allocator),
    environment = new AokanaDisplayObjectEnvironment(
      compositor,
      new AokanaDisplayDamage(16, {left: 0, top: 0, right: 1, bottom: 1}),
    ),
    display = new AokanaNativeDisplayState(1920, 1080),
    manager = new AokanaDisplayManager(environment, surfaces, display),
    input = new AokanaNativeInput(display, clock),
    procedures = new AokanaProcedureState(),
    thread = new AokanaBpThread({id: 1, operandCapacity: 32, moduleCapacity: 0, frameCapacity: 0}),
    scheduler = new AokanaBpScheduler(
      new AokanaBpThread({id: 0, operandCapacity: 0, moduleCapacity: 0, frameCapacity: 0}),
      () => 0,
    ),
    node = scheduler.append(thread),
    context = {thread, memory: new AokanaBpMemory(new Uint8Array(0)), diagnostics: {}},
    [slot] = createGroup90DisplayShake(manager, scheduler, procedures, clock, input, {
      files: {text},
      threadFatal() {
        assert.fail('ordinary object shake should succeed');
      },
    }),
    handle = manager.createSprite(),
    sprite = manager.resolve(handle);
  const start = (mode) => {
    // 16-pixel amplitude, two cycles/second, two cycles, 50% decay, eight frames/second.
    [handle, mode, 16, 2, 2, 50, 8, 1, 1].forEach((value) => push32(thread, value));
    assert.equal(slot.execute(context), 2);
    assert.equal(thread.stackIndex, 0);
    assert.notEqual(node.process, null);
    assert.equal(node.flags & 1, 1);
  };
  const completed = (status, metric) => {
    assert.equal(node.process, null);
    assert.equal(node.flags & 1, 0);
    assert.equal(pop32(thread), status);
    assert.equal(pop32(thread), metric);
    assert.equal(thread.stackIndex, 0);
    assert.deepEqual(sprite.position(), {x: 20, y: 40});
    assert.equal(sprite.getBlendValue(), 77);
    assert.equal(sprite.getValueD8(0), 6);
    assert.equal(input.keyCaptureAllowed(0), true);
  };
  try {
    sprite.move(20, 40);
    sprite.setBlendValue(77);
    sprite.setValueD8(0, 6);
    start(0);
    tick = 125;
    assert.equal(await node.pollProcess(false), 0);
    assert.deepEqual(sprite.position(), {x: 20, y: 24});
    assert.equal(manager.redraw.pending, 1);
    tick = 250;
    assert.equal(await node.pollProcess(false), 0);
    assert.deepEqual(sprite.position(), {x: 20, y: 32});
    tick = 500;
    assert.equal(await node.pollProcess(false), 0);
    assert.deepEqual(sprite.position(), {x: 20, y: 36});
    tick = 1000;
    assert.equal(await node.pollProcess(false), 1);
    completed(0, 500);

    const expected = [
      null,
      [
        {x: 20, y: 56},
        {x: 20, y: 48},
      ],
      [
        {x: 4, y: 40},
        {x: 12, y: 40},
      ],
      [
        {x: 36, y: 40},
        {x: 28, y: 40},
      ],
      [
        {x: 20, y: 40},
        {x: 20, y: 32},
      ],
      [
        {x: 20, y: 40},
        {x: 12, y: 40},
      ],
    ];
    for (let mode = 1; mode <= 5; mode++) {
      start(mode);
      tick += 125;
      assert.equal(await node.pollProcess(false), 0);
      assert.deepEqual(sprite.position(), expected[mode][0]);
      tick += 125;
      assert.equal(await node.pollProcess(false), 0);
      assert.deepEqual(sprite.position(), expected[mode][1]);
      node.process.enqueueMessage({code: 1, value1: 1, value2: 0});
      assert.equal(await node.pollProcess(false), 1);
      completed(1, 375);
    }
    assert.equal(procedures.nextId, 6);
  } finally {
    manager.dispose();
  }
});
