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
import {createGroup90CoordinateSplineControl} from '../dist/engines/buriko/native/group-90-coordinate-spline-control.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BurikoProcedureState} from '../dist/engines/buriko/native/procedure.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

test('coordinate spline controls share scheduled waits, spline sampling, sort lists and capture completion', async () => {
  let tick = 0;
  const clock = new BurikoNativeClock(() => tick),
    text = new BurikoNativeText(),
    fonts = new BurikoNativeFonts(text),
    compositor = new BurikoBitmapCompositor(),
    surfaces = new BurikoSurfaces(fonts, compositor, new BurikoDistributedAllocator(1)),
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
    bytes = new Uint8Array(128),
    view = new DataView(bytes.buffer),
    context = {thread, memory: new BurikoBpMemory(bytes), diagnostics: {}},
    slots = createGroup90CoordinateSplineControl(manager, scheduler, procedures, clock, input, {
      files: {text},
      threadFatal() {
        assert.fail('ordinary coordinate controls should succeed');
      },
    }),
    handle = manager.createSprite(),
    sprite = manager.resolve(handle);
  assert.deepEqual(
    slots.map((s) => [s.primary, s.secondary, s.nativeAddress]),
    [[0x90, 0x29, 0x1400dc070]],
  );
  sprite.sortMode = 1;
  sprite.coordinateRounding = 0;
  sprite.setValueD8(0, 2);
  manager.lists.resort(sprite);
  const start = (points, blend, packed, depth, capture = 0, limit = 0) => {
    points.forEach((point, index) => {
      point.forEach((coordinate, axis) =>
        view.setInt32(16 + index * 16 + axis * 4, coordinate, true),
      );
      view.setUint32(16 + index * 16 + 12, 0x12345678, true);
    });
    const previous = thread.stackIndex;
    [handle, points.length, 16, 0, blend, packed, depth, 100, 50, limit, capture, 1].forEach(
      (value) => push32(thread, value),
    );
    assert.equal(slots[0].execute(context), 2);
    assert.equal(thread.stackIndex, previous);
    assert.notEqual(node.process, null);
  };
  const finish = (status, metric) => {
    assert.equal(node.process, null);
    assert.equal(pop32(thread), status);
    assert.equal(pop32(thread), metric);
  };
  const checkSort = () => {
    assert.equal(
      manager.lists.snapshot(false).find((entry) => entry.object === sprite).key,
      sprite.sortKey(),
    );
  };
  try {
    start([[100 << 16, 80 << 16, 32 << 16]], 128, 0x80000000, 10);
    tick = 25;
    assert.equal(await node.pollProcess(false), 0);
    assert.deepEqual(sprite.coordinates(), {x: 25 << 16, y: 20 << 16, z: 8 << 16});
    assert.deepEqual(sprite.position(), {x: 25, y: 20});
    assert.equal(sprite.getBlendValue(), 64);
    assert.equal(sprite.getValueD8(1), 4 << 16);
    assert.equal(manager.redraw.pending, 1);
    checkSort();
    tick = 50;
    assert.equal(await node.pollProcess(false), 0);
    assert.equal(sprite.getBlendValue(), 128);
    assert.deepEqual(sprite.coordinates(), {x: 50 << 16, y: 40 << 16, z: 16 << 16});
    tick = 100;
    assert.equal(await node.pollProcess(false), 1);
    finish(0, 30);
    checkSort();
    assert.deepEqual(sprite.coordinates(), {x: 100 << 16, y: 80 << 16, z: 32 << 16});
    assert.equal(sprite.getValueD8(1), 10 << 16);

    sprite.setCoordinates(0, 0, 0);
    manager.lists.resort(sprite);
    start(
      [
        [50 << 16, 100 << 16, 0],
        [100 << 16, 0, 0],
      ],
      0,
      0,
      -1,
      1,
    );
    tick = 125;
    assert.equal(await node.pollProcess(false), 0);
    // Independent natural cubic: y(t)=150t-50t^3 on segment zero, t=1/2.
    assert.deepEqual(sprite.coordinates(), {x: 25 << 16, y: 4505600, z: 0});
    assert.equal(sprite.getBlendValue(), 96);
    assert.equal(sprite.getValueD8(1), 10 << 16);
    input.recordKeyDown(13);
    assert.equal(await node.pollProcess(false), 1);
    finish(1, 20);
    assert.deepEqual(sprite.coordinates(), {x: 100 << 16, y: 0, z: 0});
    assert.equal(input.keyCaptureAllowed(0), true);

    // Independent blend easing runs over its own speed while frame limiting caps elapsed.
    start([[200 << 16, 40 << 16, 8 << 16]], 128, 4, -1, 0, 1);
    tick = 225;
    assert.equal(await node.pollProcess(false), 0);
    assert.deepEqual(sprite.coordinates(), {x: 7864300, y: 524280, z: 104856});
    // Q24 truncation followed by the squared selector yields Q16 2621; 128*2621>>16=5.
    assert.equal(sprite.getBlendValue(), 5);
    node.process.enqueueMessage({code: 1, value1: 1, value2: 0});
    assert.equal(await node.pollProcess(false), 1);
    finish(1, 20);
    assert.deepEqual(sprite.coordinates(), {x: 200 << 16, y: 40 << 16, z: 8 << 16});
    assert.equal(sprite.getBlendValue(), 128);
    checkSort();
  } finally {
    manager.dispose();
  }
});
