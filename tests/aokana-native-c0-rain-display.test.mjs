import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AokanaDisplayObject,
  AokanaDisplayObjectEnvironment,
} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaRainDisplayState} from '../dist/engines/buriko/games/aokana/native/display-rain.js';
import {AokanaRainDisplays} from '../dist/engines/buriko/games/aokana/native/rain-displays.js';
import {AokanaSystemTicks} from '../dist/engines/buriko/games/aokana/native/system-ticks.js';
import {AokanaCrtRandom} from '../dist/engines/buriko/games/aokana/native/system-timing.js';
import {createGroupC0Rain} from '../dist/engines/buriko/games/aokana/native/group-c0-rain.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';

function fixture() {
  const compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 1;
  const environment = new AokanaDisplayObjectEnvironment(
    compositor,
    new AokanaDisplayDamage(64, {left: 0, top: 0, right: 999, bottom: 999}),
  );
  const surfaces = new AokanaSurfaces(null, compositor, {currentActor: {}});
  const manager = new AokanaDisplayManager(
    environment,
    surfaces,
    new AokanaNativeDisplayState(1000, 1000),
  );
  const state = new AokanaRainDisplayState();
  const rain = new AokanaRainDisplays(
    manager,
    state,
    new AokanaCrtRandom(),
    new AokanaSystemTicks({now: () => 100}),
  );
  return {rain, state, manager, compositor, environment, surfaces};
}

test('rain creation uses shared manager slots and the native previous creation order', () => {
  const {rain, manager} = fixture();
  const first = rain.create(20, 30),
    second = rain.create(40, 50);
  assert.deepEqual(first, {result: 0, handle: 0xc1000000});
  assert.deepEqual(second, {result: 0, handle: 0xc1000001});
  const object = rain.find(first.handle);
  assert.equal(object, manager.find('rain', first.handle));
  assert.equal(object, manager.resolve(first.handle));
  assert.equal(manager.categoryCount(7), 2);
  assert.equal(manager.creationCount('rain'), 2);
  assert.equal(object.depthOrder, 0);
  assert.equal(rain.find(second.handle).depthOrder, 1);
  assert.ok(manager.lists.snapshot(false).some((entry) => entry.object === object));
  assert.equal(object.rainBitmap.format, 2);
  assert.equal(object.bitmap.format, 1);
});

test('rain setters save values before start and later propagate complete parameter blocks', () => {
  const {rain} = fixture(),
    {handle} = rain.create(20, 20),
    object = rain.find(handle);
  assert.equal(
    rain.updateSetting(handle, (object) => object.setBounds(1, 2, 3, 4, 5, 6)),
    2,
  );
  assert.equal(
    rain.updateSetting(handle, (object) => object.setSpeed(17)),
    2,
  );
  assert.equal(
    rain.updateSetting(handle, (object) => object.setDropLength(19)),
    2,
  );
  assert.equal(
    rain.updateSetting(handle, (object) => object.setTickInterval(13)),
    2,
  );
  assert.equal(
    rain.updateSetting(handle, (object) => object.setCameraPosition(10, 20, 30)),
    2,
  );
  assert.equal(
    rain.updateSetting(handle, (object) => object.setCameraRotation(40, 50, 60)),
    2,
  );
  assert.equal(
    rain.updateSetting(handle, (object) => object.setProjectionDistance(90)),
    2,
  );
  assert.equal(rain.start(handle, 7), true);
  assert.deepEqual(
    [...object.rain.parameters],
    [1, 2, 3, 4, 5, 6, 0, -1, 0, 17 << 8, 19 << 8, -1, 0, 20, 13, 1],
  );
  assert.deepEqual([...object.rain.transform], [10, 20, 30, 40, 50, 60, 90]);
  assert.equal(object.rain.previousTick, 93);
  assert.equal(
    rain.updateSetting(handle, (object) => object.setColor(0x81234567)),
    0,
  );
  assert.equal(object.rain.parameters[11] >>> 0, 0x81234567);
  assert.equal(
    rain.updateSetting(handle, (object) => object.setSpawnCount(-2)),
    0,
  );
  assert.equal(object.rain.parameters[13], -2);
  assert.equal(
    rain.updateSetting(handle, (object) => object.setSpeed(0)),
    3,
  );
  assert.equal(object.rain.parameters[9], 17 << 8);
});

test('rain display configuration keeps virtual child propagation and separate global visibility', () => {
  const {rain, state, environment, manager} = fixture();
  const {handle} = rain.create(20, 20),
    object = rain.find(handle);
  const child = new AokanaDisplayObject(environment, 0, 0, 1);
  object.addChild(child, 2, 3);
  assert.equal(rain.setActivation(handle, 1), true);
  assert.equal(child.activation, 1);
  assert.equal(object.inputActive(), 1);
  assert.equal(rain.configureDisplay(handle, 7, 11, 0x20, 31, 5), 0);
  assert.deepEqual(object.position(), {x: 7, y: 11});
  assert.deepEqual(child.position(), {x: 9, y: 14});
  assert.equal(child.blendValue, 31);
  assert.equal(child.blendMode, 0x80);
  assert.equal(child.layer, 0);
  assert.equal(object.blendMode, 0x20);
  assert.equal(object.layer, 5);
  assert.equal(manager.lists.snapshot(false).at(-1).object, object);
  state.enabled = 0;
  assert.equal(object.inputActive(), 0);
  assert.equal(child.inputActive(), 1);
});

test('rain mask selection and cropped draw use the shared surface and compositor', () => {
  const {rain, surfaces, compositor} = fixture();
  const {handle} = rain.create(4, 2),
    object = rain.find(handle);
  assert.equal(surfaces.allocate(3, 4, 2, 3), 1);
  const mask = surfaces.descriptor(3);
  mask.storage.bytes.fill(0);
  mask.storage.bytes.set([0, 1, 0, 1, 1, 1, 1, 1]);
  mask.storage.written(0, 8);
  assert.equal(rain.selectMask(handle, 3), 0);
  const values = new Uint32Array(object.rainBitmap.storage.bytes.buffer);
  values.set([1, 2, 3, 4, 5, 6, 7, 8]);
  const composites = [];
  compositor.composite = (destination, source, mode, value, option) => {
    const input = [];
    for (let y = 0; y < source.height; y++)
      for (let x = 0; x < source.width; x++)
        input.push(source.storage.view.getUint32(source.offset + y * source.stride + x * 4, true));
    composites.push({
      destination,
      width: source.width,
      height: source.height,
      input,
      mode,
      value,
      option,
    });
  };
  object.configureDisplay(0, 0, 0x80, 0, 0);
  const destination = {width: 2, height: 1};
  object.draw(destination, {left: 1, top: 0, right: 2, bottom: 0}, 0);
  assert.deepEqual(composites[0], {
    destination,
    width: 2,
    height: 1,
    input: [2, 0],
    mode: 0x80,
    value: 0,
    option: true,
  });
  assert.equal(rain.selectMask(handle, 0xffffffff), 0);
  object.draw(destination, {left: 1, top: 1, right: 2, bottom: 1}, 0);
  assert.deepEqual(composites[1].input, [6, 7]);
});

test('C0 rain definitions preserve every success stack contract and validation order', () => {
  const {rain, state, manager} = fixture();
  const fatal = [];
  const errors = {
    files: {text: {encodeWide: (text) => text}},
    threadFatal: (_thread, _diagnostics, message) => {
      fatal.push(message);
      throw new Error(message);
    },
  };
  const definitions = createGroupC0Rain(rain, manager.redraw, errors);
  assert.equal(definitions.length, 16);
  for (const definition of definitions)
    assert.equal(
      definition.nativeAddress,
      AOKANA_NATIVE_SLOT_ADDRESSES[0xc0][definition.secondary],
    );
  const handlers = new Map(definitions.map((slot) => [slot.secondary, slot.execute]));
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 32,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, diagnostics: {}};
  const call = (code, args) => {
    args.forEach((value) => push32(thread, value));
    return handlers.get(code)(context);
  };
  assert.equal(call(0x40, [20, 20]), 0);
  const handle = pop32(thread),
    object = rain.find(handle);
  assert.equal(call(0x42, [handle, 1]), 0);
  assert.equal(call(0x43, [handle, 0xffffffff]), 0);
  assert.equal(call(0x44, [handle, 1]), 0);
  assert.equal(call(0x45, [handle, 4, 5, 0x20, 17, 2]), 0);
  assert.equal(call(0x46, [handle, 1, 2, 3, 4, 5, 6]), 0);
  for (const [opcode, value] of [
    [0x47, 11],
    [0x48, 12],
    [0x49, 0x91234567],
    [0x4a, 13],
    [0x4b, 14],
    [0x4e, 15],
  ])
    assert.equal(call(opcode, [handle, value]), 0);
  assert.equal(call(0x4c, [handle, 16, 17, 18]), 0);
  assert.equal(call(0x4d, [handle, 19, 20, 21]), 0);
  assert.deepEqual(
    [...object.rain.parameters],
    [1, 2, 3, 4, 5, 6, 0, -1, 0, 11 << 8, 12 << 8, 0x91234567 | 0, 0, 13, 14, 1],
  );
  assert.deepEqual([...object.rain.transform], [16, 17, 18, 19, 20, 21, 15]);
  assert.equal(call(0x4f, [1, 60]), 0);
  assert.equal(state.frameInterval, 16);
  assert.equal(state.accumulatedMilliseconds, 0);
  assert.equal(manager.redraw.pending, 1);
  assert.equal(call(0x41, [handle]), 0);
  assert.equal(manager.find('rain', handle), null);
  assert.equal(manager.categoryCount(7), 0);
  assert.throws(() => call(0x45, [0, 0, 0, 999, 999, 999999]), /プライオリティ/);
  assert.throws(() => call(0x45, [0, 0, 0, 999, 999, 0]), /トランスペアレンシィ/);
  assert.throws(() => call(0x45, [0, 0, 0, 999, 0, 0]), /エフェクトモード/);
  assert.throws(() => call(0x4f, [1, 0]), /フレームレート/);
  assert.equal(thread.stackIndex, 0);
  assert.equal(fatal.length, 4);
});
