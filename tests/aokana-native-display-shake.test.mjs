import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpScheduler} from '../dist/engines/buriko/bp/scheduler.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {BurikoDisplayObjectEnvironment} from '../dist/engines/buriko/native/display-object.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {createGroup90DisplayShake} from '../dist/engines/buriko/native/group-90-display-shake.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BurikoProcedureState} from '../dist/engines/buriko/native/procedure.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

test('object shake schedules all six triangular modes, decay, catch-up and shared completion', async () => {
  let tick = 0;
  const clock = new BurikoNativeClock(() => tick),
    text = new BurikoNativeText(),
    fonts = new BurikoNativeFonts(text),
    compositor = new BurikoBitmapCompositor(),
    allocator = new BurikoDistributedAllocator(1),
    surfaces = new BurikoSurfaces(fonts, compositor, allocator),
    environment = new BurikoDisplayObjectEnvironment(
      compositor,
      new BurikoDisplayDamage(16, {left: 0, top: 0, right: 1, bottom: 1}),
    ),
    display = new BurikoNativeDisplayState(1920, 1080),
    manager = new BurikoDisplayManager(environment, surfaces, display),
    input = new BurikoNativeInput(display, clock),
    procedures = new BurikoProcedureState(),
    thread = new BurikoBpThread({id: 1, operandCapacity: 32, moduleCapacity: 0, frameCapacity: 0}),
    scheduler = new BurikoBpScheduler(
      new BurikoBpThread({id: 0, operandCapacity: 0, moduleCapacity: 0, frameCapacity: 0}),
      () => 0,
    ),
    node = scheduler.append(thread),
    context = {thread, memory: new BurikoBpMemory(new Uint8Array(0)), diagnostics: {}},
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
