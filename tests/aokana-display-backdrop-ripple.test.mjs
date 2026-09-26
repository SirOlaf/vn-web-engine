import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaBitmapStorage} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {AokanaRippleBackdrop} from '../dist/engines/buriko/games/aokana/native/display-backdrop.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaDisplayRenderer} from '../dist/engines/buriko/games/aokana/native/display-renderer.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {createGroup90RippleBackdrop} from '../dist/engines/buriko/games/aokana/native/group-90-backdrop-ripple.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

const rectangle = (left, top, right, bottom) => ({left, top, right, bottom});
const gray = (value) => Math.imul(value, 0x01010101) >>> 0;
const bitmap = (width, height, values = []) => ({
  storage: new AokanaBitmapStorage(
    new Uint8Array(
      new Uint32Array(
        Array.from({length: width * height}, (_, index) => values[index] ?? 0),
      ).buffer,
    ),
    true,
  ),
  offset: 0,
  stride: width * 4,
  width,
  height,
  format: 2,
  bytesPerPixel: 4,
});

function fixture() {
  const compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 2;
  const bounds = rectangle(0, 0, 2, 1),
    output = bitmap(3, 2),
    environment = new AokanaDisplayObjectEnvironment(
      compositor,
      new AokanaDisplayDamage(16, {...bounds}),
    );
  environment.displayContext = {bitmap: output, bounds};
  const allocator = new AokanaDistributedAllocator(2),
    text = new AokanaNativeText(),
    surfaces = new AokanaSurfaces(new AokanaNativeFonts(text), compositor, allocator),
    manager = new AokanaDisplayManager(
      environment,
      surfaces,
      new AokanaNativeDisplayState(1920, 1080),
    );
  return {allocator, compositor, environment, manager, output, surfaces, text};
}

function writeSource(surfaces, slot) {
  assert.equal(surfaces.allocate(slot, 4, 2, 2), 1);
  const source = surfaces.descriptor(slot),
    values = [10, 20, 30, 40, 50, 60, 70, 80].map(gray);
  values.forEach((value, index) => source.storage.view.setUint32(index * 4, value, true));
  source.storage.written(0, source.storage.bytes.length);
}

function writeMap(surfaces, slot, dx) {
  if (surfaces.descriptor(slot) === null) assert.equal(surfaces.allocate(slot, 3, 2, 6), 1);
  const map = surfaces.descriptor(slot);
  for (let index = 0; index < 6; index++) {
    const offset = index * 6;
    map.storage.view.setInt16(offset, dx, true);
    map.storage.view.setInt16(offset + 2, 0, true);
    map.storage.view.setUint16(offset + 4, 1, true);
  }
  map.storage.written(0, map.storage.bytes.length);
}

const pixels = (value) =>
  Array.from({length: value.width * value.height}, (_, index) =>
    value.storage.view.getUint32(index * 4, true),
  );

test('type-eight selection preserves source-before-map failure and reuses its concrete backdrop', () => {
  const {environment, manager, surfaces} = fixture();
  writeSource(surfaces, 3);
  assert.equal(surfaces.coefficientTables.configureRipple(2, 1, 256, 2, 2), 0);
  manager.setBackdropActivation(1, 7);
  environment.damage.clear();
  const previous = manager.backdrop;
  assert.equal(manager.configureRippleBackdrop(3, 4, 1, 2, 256), 3);
  const ripple = manager.backdrop;
  assert.ok(ripple instanceof AokanaRippleBackdrop);
  assert.notEqual(ripple, previous);
  assert.deepEqual(
    [ripple.sourceSurface, ripple.mapSurface, ripple.activation, ripple.contentEnabled],
    [3, -1, 1, 7],
  );
  assert.equal(manager.backdropRenderType, 8);
  assert.equal(environment.damage.fullRedraw, 1);
  assert.deepEqual(manager.lists.snapshot(false).map((entry) => entry.object), [ripple]);

  writeMap(surfaces, 4, 256);
  assert.equal(manager.configureRippleBackdrop(3, 4, 1, 2, 256), 0);
  assert.equal(manager.backdrop, ripple);
  assert.deepEqual(manager.lists.snapshot(false).map((entry) => entry.object), [ripple]);
});

test('ripple backdrop uses default nearest sampling, bilinear selection and offset expansion', () => {
  const {allocator, manager, output, surfaces} = fixture();
  writeSource(surfaces, 3);
  writeMap(surfaces, 4, 256);
  assert.equal(surfaces.coefficientTables.configureRipple(2, 1, 256, 2, 2), 0);
  manager.setBackdropActivation(1, 1);
  assert.equal(manager.configureRippleBackdrop(3, 4, 1, 2, 256), 0);
  const ripple = manager.backdrop;
  assert.ok(ripple instanceof AokanaRippleBackdrop);
  assert.equal(ripple.sampling, 0);

  const processing = new AokanaDistributedProcessing(allocator, 2),
    dispatchModes = [],
    run = processing.run.bind(processing);
  processing.run = (distributedFlag) => {
    dispatchModes.push(distributedFlag);
    return run(distributedFlag);
  };
  const renderer = new AokanaDisplayRenderer(manager, 3, processing);
  renderer.drawFull();
  assert.deepEqual(dispatchModes, [1]);
  assert.deepEqual(pixels(output), [20, 30, 40, 60, 70, 80].map(gray));

  writeMap(surfaces, 4, 128);
  assert.equal(ripple.setProperty(0xff, 1, 0), 0);
  assert.equal(manager.configureRippleBackdrop(3, 4, 1, 2, 256), 0);
  assert.equal(manager.backdrop, ripple);
  assert.equal(ripple.sampling, 1);
  renderer.drawFull();
  assert.deepEqual(dispatchModes, [1, 1]);
  assert.deepEqual(pixels(output), [15, 25, 35, 55, 65, 75].map(gray));

  writeMap(surfaces, 4, 256);
  assert.equal(ripple.setProperty(0xff, 0, 0), 0);
  assert.equal(ripple.setProperty(0x100, 1, 0x101), 0);
  assert.equal(ripple.getBlendValue(), 256);
  renderer.drawFull();
  assert.deepEqual(dispatchModes, [1, 1, 1]);
  assert.deepEqual(pixels(output), [10, 20, 30, 50, 60, 70].map(gray));
});

test('90:47 consumes its native stack order and reports its exact source error', () => {
  const {manager, surfaces} = fixture(),
    failures = [],
    definitions = createGroup90RippleBackdrop(manager, {
      files: {text: {encodeWide: (message) => message}},
      threadFatal: (_thread, _diagnostics, message) => {
        failures.push(message);
        throw new Error('native fatal');
      },
    });
  assert.equal(definitions.length, 1);
  const definition = definitions[0];
  assert.deepEqual([definition.primary, definition.secondary], [0x90, 0x47]);
  assert.equal(definition.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x90][0x47]);
  const thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    context = {
      thread,
      memory: new AokanaBpMemory(new Uint8Array(0)),
      diagnostics: {},
    },
    call = (args) => {
      const before = thread.stackIndex;
      args.forEach((value) => push32(thread, value));
      const result = definition.execute(context);
      assert.equal(thread.stackIndex, before);
      return result;
    };
  assert.throws(() => call([31, 4, 1, 2, 256]), /native fatal/);
  assert.equal(failures.at(-1), '指定されたビットマップ [ 31 ] は存在しません');

  writeSource(surfaces, 3);
  writeMap(surfaces, 4, 256);
  assert.equal(surfaces.coefficientTables.configureRipple(2, 1, 256, 1, 1), 0);
  assert.equal(call([3, 4, 1, 2, 256]), 0);
  assert.ok(manager.backdrop instanceof AokanaRippleBackdrop);
});
