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
import {createGroup90DisplayControl} from '../dist/engines/buriko/games/aokana/native/group-90-display-control.js';
import {AokanaNativeInput} from '../dist/engines/buriko/games/aokana/native/input.js';
import {AokanaProcedureState} from '../dist/engines/buriko/games/aokana/native/procedure.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

test('display controls share scheduled waits, sprite state, redraws, and input/message completion', async () => {
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
    slots = createGroup90DisplayControl(manager, scheduler, procedures, clock, input, {
      files: {text},
      threadFatal() {
        assert.fail('ordinary display controls should succeed');
      },
    }),
    handle = manager.createSprite(),
    sprite = manager.resolve(handle);
  const start = (slot, args) => {
    const depth = thread.stackIndex;
    args.forEach((value) => push32(thread, value));
    assert.equal(slots.find((entry) => entry.secondary === slot).execute(context), 2);
    assert.equal(thread.stackIndex, depth);
    assert.notEqual(node.process, null);
    assert.equal(node.flags & 1, 1);
  };
  const finish = (status, metric) => {
    assert.equal(node.process, null);
    assert.equal(node.flags & 1, 0);
    assert.equal(pop32(thread), status);
    assert.equal(pop32(thread), metric);
  };
  try {
    start(0x20, [handle, 64, 100, 60, 0, 1]);
    tick = 50;
    assert.equal(await node.pollProcess(false), 0);
    assert.equal(sprite.getBlendValue(), 32);
    assert.equal(manager.redraw.pending, 1);
    tick = 100;
    assert.equal(await node.pollProcess(false), 1);
    finish(0, 20);

    start(0x21, [handle, 100, 80, 4, 128, 100, 60, 0, 1]);
    tick = 150;
    assert.equal(await node.pollProcess(false), 0);
    assert.deepEqual(sprite.position(), {x: 25, y: 20});
    assert.equal(sprite.getBlendValue(), 96);
    tick = 200;
    assert.equal(await node.pollProcess(false), 1);
    finish(0, 20);

    start(0x22, [handle, 64, 100, 50, 1, 0, 1]);
    for (let step = 1; step <= 5; step++) {
      tick = 200 + step * 20;
      assert.equal(await node.pollProcess(false), Number(step === 5));
    }
    finish(0, 50);
    assert.equal(sprite.getBlendValue(), 64);

    start(0x23, [handle, 200, 160, 6, 32, 100, 50, 1, 1, 1]);
    tick = 320;
    assert.equal(await node.pollProcess(false), 0);
    node.process.enqueueMessage({code: 1, value1: 0, value2: 0});
    assert.equal(await node.pollProcess(false), 1);
    finish(1, 20);
    assert.deepEqual(sprite.position(), {x: 200, y: 160});
    assert.equal(input.keyCaptureAllowed(0), true);

    start(0x24, [handle, 250, 200, 300, 160, 0, 0, 100, 50, 0, 1, 1]);
    tick = 360;
    assert.equal(await node.pollProcess(false), 0);
    assert.deepEqual(sprite.position(), {x: 240, y: 198});
    input.recordKeyDown(13);
    assert.equal(await node.pollProcess(false), 1);
    finish(1, 400);
    assert.deepEqual(sprite.position(), {x: 300, y: 160});
    assert.equal(sprite.getBlendValue(), 0);
    assert.equal(input.keyCaptureAllowed(0), true);
    sprite.setValueD8(0, 4);
    start(0x28, [handle, 380, 240, 0, 128, 4, 12, 100, 50, 0, 0, 1]);
    tick = 410;
    assert.equal(await node.pollProcess(false), 0);
    assert.deepEqual(sprite.position(), {x: 340, y: 200});
    assert.equal(sprite.getBlendValue(), 32);
    assert.equal(sprite.getValueD8(1), 8 << 16);
    tick = 460;
    assert.equal(await node.pollProcess(false), 1);
    finish(0, 20);
    assert.equal(sprite.getValueD8(1), 12 << 16);
    assert.equal(sprite.getBlendValue(), 128);

    // The ordinary -1 addition-level sentinel retains depth on forced completion.
    start(0x28, [handle, 400, 260, 4, 64, 0, 0xffffffff, 100, 50, 1, 1, 1]);
    node.process.enqueueMessage({code: 1, value1: 1, value2: 0});
    assert.equal(await node.pollProcess(false), 1);
    finish(1, 10);
    assert.deepEqual(sprite.position(), {x: 400, y: 260});
    assert.equal(sprite.getBlendValue(), 64);
    assert.equal(sprite.getValueD8(1), 12 << 16);
    assert.equal(input.keyCaptureAllowed(0), true);
    assert.equal(procedures.nextId, 7);
  } finally {
    manager.dispose();
  }
});
