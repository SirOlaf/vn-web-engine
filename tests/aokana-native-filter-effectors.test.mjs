import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {nativeDisplayEasing} from '../dist/engines/buriko/games/aokana/bp/opcodes/native-math.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {
  applyAokanaEffectorBlur,
  applyAokanaEffectorVectorMap,
} from '../dist/engines/buriko/games/aokana/native/bitmap-display-filters.js';
import {AokanaBitmapStorage} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaDisplayEffector} from '../dist/engines/buriko/games/aokana/native/display-effector.js';
import {AokanaDisplayFilter} from '../dist/engines/buriko/games/aokana/native/display-filter.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaFilterDisplays} from '../dist/engines/buriko/games/aokana/native/filter-displays.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {createGroup90Filters} from '../dist/engines/buriko/games/aokana/native/group-90-filters.js';
import {createGroup91Effectors} from '../dist/engines/buriko/games/aokana/native/group-91-effectors.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

function fixture(width = 3, height = 1) {
  const compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 1;
  const bounds = {left: 0, top: 0, right: width - 1, bottom: height - 1},
    output = {
      storage: new AokanaBitmapStorage(new Uint8Array(width * height * 4), true),
      offset: 0,
      stride: width * 4,
      width,
      height,
      format: 1,
      bytesPerPixel: 4,
    },
    environment = new AokanaDisplayObjectEnvironment(
      compositor,
      new AokanaDisplayDamage(16, {...bounds}),
    );
  environment.displayContext = {bitmap: output, bounds};
  const allocator = new AokanaDistributedAllocator(1),
    text = new AokanaNativeText(),
    surfaces = new AokanaSurfaces(new AokanaNativeFonts(text), compositor, allocator),
    manager = new AokanaDisplayManager(
      environment,
      surfaces,
      new AokanaNativeDisplayState(1920, 1080),
    ),
    filters = new AokanaFilterDisplays(manager),
    errors = {
      files: {text: {encodeWide: (message) => message}},
      threadFatal() {
        assert.fail('ordinary Filter/Effector operations should not raise a thread error');
      },
    },
    definitions = [
      ...createGroup90Filters(filters, errors),
      ...createGroup91Effectors(filters, errors),
    ],
    thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 32,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    context = {
      thread,
      memory: new AokanaBpMemory(new Uint8Array(0)),
      diagnostics: {},
    },
    call = (primary, secondary, args, pushed = 0) => {
      const before = thread.stackIndex;
      for (const value of args) push32(thread, value);
      const definition = definitions.find(
        (candidate) => candidate.primary === primary && candidate.secondary === secondary,
      );
      assert.ok(definition);
      assert.equal(definition.execute(context), 0);
      assert.equal(thread.stackIndex, before + pushed);
    };
  return {
    bounds,
    call,
    definitions,
    environment,
    filters,
    manager,
    output,
    surfaces,
    thread,
  };
}

function allocateSurface(surfaces, slot, width, height, format) {
  assert.equal(surfaces.allocate(slot, width, height, format), 1);
  return surfaces.descriptor(slot);
}

function bitmapDescriptor(width, height, format) {
  return {
    storage: new AokanaBitmapStorage(new Uint8Array(width * height * 4), true),
    offset: 0,
    stride: width * 4,
    width,
    height,
    format,
    bytesPerPixel: 4,
  };
}

test('thirteen Filter and Effector wrappers preserve ordinary stack, pool and mode state', () => {
  const s = fixture();
  assert.deepEqual(
    s.definitions.map(({primary, secondary}) => [primary, secondary]),
    [
      [0x90, 0x60],
      [0x90, 0x61],
      [0x90, 0x64],
      [0x90, 0x65],
      [0x90, 0x66],
      [0x91, 0x60],
      [0x91, 0x61],
      [0x91, 0x64],
      [0x91, 0x65],
      [0x91, 0x66],
      [0x91, 0x67],
      [0x91, 0x68],
      [0x91, 0x69],
    ],
  );
  for (const definition of s.definitions)
    assert.equal(
      definition.nativeAddress,
      AOKANA_NATIVE_SLOT_ADDRESSES[definition.primary][definition.secondary],
    );

  s.call(0x90, 0x60, [], 1);
  const filterHandle = pop32(s.thread),
    filter = s.manager.find('filter', filterHandle);
  assert.equal(filterHandle, 0x90000000);
  assert.ok(filter instanceof AokanaDisplayFilter);
  s.call(0x90, 0x65, [filterHandle, 0x304050, 0x80, 2]);
  s.call(0x90, 0x64, [filterHandle, 1]);

  const mask = allocateSurface(s.surfaces, 3, 3, 1, 3);
  mask.storage.bytes.set([0, 128, 255]);
  mask.storage.written(0, 3);
  s.call(0x90, 0x66, [filterHandle, 0, 0x010203, 3, 0, 0x100, 4]);
  for (const [index, pixel] of [0x102030, 0x405060, 0x708090].entries())
    s.output.storage.view.setUint32(index * 4, pixel, true);
  filter.draw(s.output, s.bounds, 0);
  assert.deepEqual(
    Array.from({length: 3}, (_, index) => s.output.storage.view.getUint32(index * 4, true)),
    [0x010203, 0x010203, 0x010203],
  );

  s.call(0x91, 0x60, [], 1);
  const effectorHandle = pop32(s.thread),
    effector = s.manager.find('effector', effectorHandle);
  assert.equal(effectorHandle, 0x91000000);
  assert.ok(effector instanceof AokanaDisplayEffector);

  const primaryMap = allocateSurface(s.surfaces, 4, 3, 1, 4),
    secondaryMap = allocateSurface(s.surfaces, 5, 3, 1, 4);
  primaryMap.storage.bytes.fill(0);
  primaryMap.storage.written(0, primaryMap.storage.bytes.length);
  secondaryMap.storage.bytes.fill(0);
  secondaryMap.storage.written(0, secondaryMap.storage.bytes.length);
  s.call(0x91, 0x65, [effectorHandle, 4, 5, 0x100, 1, 5]);
  assert.deepEqual(
    [effector.effectorMode, effector.primaryMap, effector.secondaryMap, effector.vectorSampling],
    [0, 4, 5, 1],
  );

  s.call(0x91, 0x66, [effectorHandle, 5, 0, 6]);
  assert.deepEqual([effector.effectorMode, effector.blurSelector], [1, 5]);

  const displacementMap = allocateSurface(s.surfaces, 6, 3, 1, 6);
  displacementMap.storage.bytes.fill(0);
  displacementMap.storage.written(0, displacementMap.storage.bytes.length);
  assert.equal(s.surfaces.coefficientTables.configureRipple(1, 1, 256, 1, 1), 0);
  s.call(0x91, 0x67, [effectorHandle, 6, 1, 1, 0x100, 7]);
  assert.deepEqual(
    [
      effector.effectorMode,
      effector.displacementMap,
      effector.coefficientCount,
      effector.coefficientSlot,
    ],
    [2, 6, 1, 1],
  );

  s.call(0x91, 0x68, [effectorHandle, 0, 0, 0, 0x10000, 0x10000, 0, 0x100, 8]);
  assert.equal(effector.effectorMode, 3);
  effector.setBlendValue(0x100);
  s.call(0x91, 0x69, [effectorHandle, 0x100, 9]);
  assert.equal(effector.effectorMode, 4);
  s.call(0x91, 0x64, [effectorHandle, 1]);

  assert.deepEqual([s.manager.categoryCount(1), s.manager.categoryCount(2)], [1, 1]);
  s.call(0x91, 0x61, [effectorHandle]);
  s.call(0x90, 0x61, [filterHandle]);
  assert.deepEqual([s.manager.categoryCount(1), s.manager.categoryCount(2)], [0, 0]);
  assert.equal(s.thread.stackIndex, 0);
});

test('Filter partial drawing crops its nonuniform screen mask to the same rectangle', () => {
  const s = fixture(3, 2);
  s.call(0x90, 0x60, [], 1);
  const filterHandle = pop32(s.thread),
    filter = s.manager.find('filter', filterHandle),
    mask = allocateSurface(s.surfaces, 3, 3, 2, 3);
  assert.ok(filter instanceof AokanaDisplayFilter);
  mask.storage.bytes.set([2, 0, 0, 2, 0, 2]);
  mask.storage.written(0, mask.storage.bytes.length);
  s.call(0x90, 0x66, [filterHandle, 0, 0x010203, 3, 8, 1, 4]);
  s.call(0x90, 0x64, [filterHandle, 1]);
  for (let index = 0; index < 6; index++)
    s.output.storage.view.setUint32(index * 4, 0x405060 + index, true);

  assert.equal(
    filter.drawClipped(
      s.environment.displayContext,
      {left: 1, top: 1, right: 2, bottom: 1},
      0,
      null,
    ),
    0,
  );
  assert.deepEqual(
    Array.from({length: 6}, (_, index) => s.output.storage.view.getUint32(index * 4, true)),
    [0x405060, 0x405061, 0x405062, 0x405063, 0x010203, 0x405065],
  );
});

test('Effector render lowers keep vector bounds rectangular and return blur mismatch status', () => {
  const compositor = new AokanaBitmapCompositor(),
    source = bitmapDescriptor(2, 2, 1),
    vectorMap = bitmapDescriptor(1, 1, 4);
  source.storage.view.setUint32(4, 0x11223344, true);
  source.storage.written(0, source.storage.bytes.length);
  vectorMap.storage.view.setUint32(0, 0x0010fff0, true);
  vectorMap.storage.written(0, vectorMap.storage.bytes.length);

  for (const filterProperty of [0, 1]) {
    compositor.filterProperty = filterProperty;
    for (const bilinear of [0, 1]) {
      const destination = bitmapDescriptor(1, 1, 1);
      destination.storage.view.setUint32(0, 0xaabbccdd, true);
      assert.equal(
        applyAokanaEffectorVectorMap(
          compositor,
          destination,
          source,
          vectorMap,
          null,
          0x100,
          bilinear,
        ),
        0,
      );
      assert.equal(destination.storage.view.getUint32(0, true), 0);
    }
  }

  assert.equal(
    applyAokanaEffectorBlur(compositor, bitmapDescriptor(1, 1, 1), bitmapDescriptor(2, 1, 1), 0, 0),
    0xf,
  );
  assert.equal(
    applyAokanaEffectorBlur(compositor, bitmapDescriptor(1, 1, 2), bitmapDescriptor(1, 1, 1), 0, 0),
    0xf,
  );
});

test('Effector transform easing retains positive-angle paths and representative pow ordering', () => {
  assert.deepEqual(
    [0, 0x800000, 0x1000000].map((progress) => nativeDisplayEasing(progress, 1)),
    [0, 32768, 65536],
  );
  assert.deepEqual(
    [0, 0x800000, 0x1000000].map((progress) => nativeDisplayEasing(progress, 2)),
    [0, 46340, 65536],
  );
  assert.deepEqual(
    [0, 0x800000, 0x1000000].map((progress) => nativeDisplayEasing(progress, 3)),
    [0, 19195, 65536],
  );
  assert.deepEqual(
    [nativeDisplayEasing(0x800000, 4), nativeDisplayEasing(0x800000, 5)],
    [16384, 49152],
  );
});
