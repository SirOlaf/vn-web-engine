import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {blendMixedBurikoBitmapsIntoRgb} from '../dist/engines/buriko/native/bitmap-mix.js';
import {BurikoBitmapStorage} from '../dist/engines/buriko/native/bitmap.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {BurikoDisplayObjectEnvironment} from '../dist/engines/buriko/native/display-object.js';
import {BurikoDisplaySprite} from '../dist/engines/buriko/native/display-sprite.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {createGroup90SpriteConfiguration} from '../dist/engines/buriko/native/group-90-sprite-configuration.js';
import {createGroup90SpriteNotifications} from '../dist/engines/buriko/native/group-90-sprite-notifications.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';

const rectangle = (width, height) => ({left: 0, top: 0, right: width - 1, bottom: height - 1});
const rgba = (value, alpha = 255) => (Math.imul(value, 0x010101) | (alpha << 24)) >>> 0;

function bitmap(width, height, format = 2, values = []) {
  const bytesPerPixel = format === 3 ? 1 : format === 6 ? 6 : 4,
    bytes = new Uint8Array(width * height * bytesPerPixel),
    storage = new BurikoBitmapStorage(bytes, true),
    result = {
      storage,
      offset: 0,
      stride: width * bytesPerPixel,
      width,
      height,
      format,
      bytesPerPixel,
    };
  if (format === 1 || format === 2)
    values.forEach((value, index) => storage.view.setUint32(index * 4, value >>> 0, true));
  else if (format === 3)
    values.forEach((value, index) => {
      storage.bytes[index] = value & 255;
    });
  return result;
}

function pixels(value) {
  return Array.from({length: value.height}, (_, y) =>
    Array.from({length: value.width}, (_, x) =>
      value.storage.view.getUint32(value.offset + y * value.stride + x * 4, true),
    ),
  ).flat();
}

function fixture(width = 80, height = 80, actors = 2, compatibility = '1.72') {
  const compositor = new BurikoBitmapCompositor(compatibility);
  compositor.defaultFormat = 2;
  const bounds = rectangle(width, height),
    environment = new BurikoDisplayObjectEnvironment(
      compositor,
      new BurikoDisplayDamage(32, {...bounds}),
    ),
    output = bitmap(width, height, 2, Array(width * height).fill(0));
  environment.displayContext = {bitmap: output, bounds};
  const allocator = new BurikoDistributedAllocator(actors),
    processing = new BurikoDistributedProcessing(allocator, actors),
    surfaces = new BurikoSurfaces(
      new BurikoNativeFonts(new BurikoNativeText()),
      compositor,
      allocator,
    );
  compositor.processing = processing;
  return {allocator, compositor, environment, output, processing, surfaces};
}

function install(surfaces, slot, source) {
  assert.equal(surfaces.allocate(slot, source.width, source.height, source.format), 1);
  const destination = surfaces.descriptor(slot);
  destination.storage.bytes.set(source.storage.bytes);
  destination.storage.written(0, destination.storage.bytes.length);
}

function zeroMap(surfaces, slot, width, height) {
  assert.equal(surfaces.allocate(slot, width, height, 6), 1);
  const map = surfaces.descriptor(slot);
  for (let index = 0; index < width * height; index++) {
    map.storage.view.setInt16(index * 6, 0, true);
    map.storage.view.setInt16(index * 6 + 2, 0, true);
    map.storage.view.setUint16(index * 6 + 4, 0, true);
  }
  map.storage.written(0, map.storage.bytes.length);
}

test('display manager inserts the real sprite and preserves ordinary mask association state', () => {
  const {environment, surfaces} = fixture(),
    manager = new BurikoDisplayManager(
      environment,
      surfaces,
      new BurikoNativeDisplayState(1920, 1080),
    ),
    ownerHandle = manager.createSprite(),
    maskHandle = manager.createSprite(),
    owner = manager.find('sprite', ownerHandle),
    mask = manager.find('sprite', maskHandle);
  assert.equal(ownerHandle, 0x80000000);
  assert.equal(maskHandle, 0x80000001);
  assert.ok(owner instanceof BurikoDisplaySprite);
  assert.ok(mask instanceof BurikoDisplaySprite);
  assert.deepEqual([owner.category, owner.depthOrder, owner.value120], [2, 0, 1]);
  assert.equal(owner.setDynamicMask(mask), 0);
  assert.equal(owner.setDynamicMask(null), 0);
  assert.equal(owner.setDynamicMask(mask), 0);
  assert.equal(manager.categoryCount(0), 2);
});

test('modes zero, one and two select simple, fused blend and affine lowers', () => {
  const {environment, surfaces} = fixture();
  install(surfaces, 1, bitmap(2, 2, 2, [rgba(10), rgba(20), rgba(30), rgba(40)]));
  install(surfaces, 2, bitmap(2, 2, 2, [rgba(110), rgba(120), rgba(130), rgba(140)]));
  const sprite = new BurikoDisplaySprite(environment, surfaces, 0);
  assert.equal(sprite.configureSimple(1), 0);
  const simple = bitmap(2, 2, 2, Array(4).fill(0));
  sprite.draw(simple, rectangle(2, 2), 0);
  assert.deepEqual(
    pixels(simple),
    [10, 20, 30, 40].map((value) => rgba(value)),
  );

  assert.equal(sprite.configureBlend(1, 2, 128, -1), 0);
  sprite.blendMode = 0;
  const blended = bitmap(2, 2, 1, Array(4).fill(0));
  sprite.draw(blended, rectangle(2, 2), 0);
  assert.deepEqual(
    pixels(blended),
    [59, 69, 79, 89].map((value) => rgba(value, 0)),
  );

  assert.equal(
    sprite.configureAffine({
      sourceSurface: 1,
      pivotX: 0,
      pivotY: 0,
      angle: 0,
      scaleX: 0x20000,
      scaleY: 0x20000,
      sampling: 0,
    }),
    0,
  );
  sprite.blendMode = 0x80;
  const affine = bitmap(3, 3, 2, Array(9).fill(0));
  sprite.draw(affine, rectangle(3, 3), 0);
  assert.deepEqual(
    pixels(affine),
    [10, 20, 20, 30, 40, 40, 30, 40, 40].map((value) => rgba(value)),
  );
});

test('animated reveal progress remains separate from the owned mask exponent in both native revisions', () => {
  const colors = [0xffe0e0e0, 0x80c0c0c0, 0xffa0a0a0, 0xff808080];
  const masks = [0, 16, 32, 48];
  for (const compatibility of ['1.69', '1.72']) {
    const {environment, surfaces} = fixture(2, 2, 1, compatibility);
    install(surfaces, 1, bitmap(2, 2, 2, colors));
    install(surfaces, 2, bitmap(2, 2, 3, masks));
    const sprite = new BurikoDisplaySprite(environment, surfaces, 0);
    assert.equal(sprite.initializeReveal(0, 0, 1, 2, 2, 0, 0x20, 64, 0), 0);
    for (const progress of [0, 32, 64, 128, 255, 256]) {
      sprite.setValueD8(0, progress);
      const direct = bitmap(2, 2, 1, Array(4).fill(0x05080808));
      sprite.draw(direct, rectangle(2, 2), 0);
      const expectedRgb = colors.map((pixel, index) => {
        const coverage = Math.max(0, Math.min(256, 5 * progress - masks[index] * 4));
        const tableIndex = (coverage * (pixel >>> 24)) >>> 9;
        const coefficient = Math.floor((tableIndex * 192) / (compatibility === '1.69' ? 256 : 8));
        const value =
          progress >= 256
            ? 8 + Math.floor((((pixel & 255) - 8) * Math.floor(((pixel >>> 25) * 192) / 256)) / 128)
            : 8 +
              Math.floor(
                (((pixel & 255) - 8) * coefficient) / (compatibility === '1.69' ? 128 : 4096),
              );
        return rgba(value, 5);
      });
      assert.deepEqual(pixels(direct), expectedRgb, `${compatibility} direct progress ${progress}`);
      sprite.blendMode = 0x80;
      const temporary = bitmap(2, 2, 2, Array(4).fill(0));
      sprite.draw(temporary, rectangle(2, 2), 0);
      assert.deepEqual(
        pixels(temporary),
        colors.map((pixel, index) => {
          if (progress === 0) return 0;
          const coverage = Math.max(
            0,
            Math.min(compatibility === '1.69' ? 256 : 255, 5 * progress - masks[index] * 4),
          );
          const alpha = progress >= 256 ? pixel >>> 24 : ((pixel >>> 24) * coverage) >>> 8;
          return ((pixel & 0xffffff) | (alpha << 24)) >>> 0;
        }),
        `${compatibility} temporary progress ${progress}`,
      );
      sprite.blendMode = 0x20;
    }
  }
});

test('modes three and four use owned reveal data and shared surface coefficients', () => {
  const {environment, surfaces} = fixture();
  install(surfaces, 1, bitmap(2, 2, 2, [rgba(9), rgba(19), rgba(29), rgba(39)]));
  install(surfaces, 2, bitmap(2, 2, 3, [0, 64, 128, 255]));
  zeroMap(surfaces, 3, 2, 2);
  assert.equal(surfaces.coefficientTables.configureRipple(1, 1, 256, 1, 1), 0);
  const sprite = new BurikoDisplaySprite(environment, surfaces, 0);
  assert.equal(sprite.configureReveal(1, 2), 0);
  sprite.setValueD8(0, 256);
  sprite.blendMode = 0x80;
  const revealed = bitmap(2, 2, 2, Array(4).fill(0));
  sprite.draw(revealed, rectangle(2, 2), 0);
  assert.deepEqual(
    pixels(revealed),
    [9, 19, 29, 39].map((value) => rgba(value)),
  );

  assert.equal(sprite.configureDisplacement(1, 3, 1, 1, 256), 0);
  const displaced = bitmap(2, 2, 2, Array(4).fill(0));
  sprite.draw(displaced, rectangle(2, 2), 0);
  assert.deepEqual(
    pixels(displaced),
    [9, 19, 29, 39].map((value) => rgba(value)),
  );
  assert.equal(sprite.setProperty(0x100, 0, 0x101), 0);
});

test('modes five and six consume mip/mix/wave and the shared mesh worker', () => {
  const {environment, processing, surfaces} = fixture(80, 80, 2),
    quadrants = Array.from({length: 16}, (_, index) => {
      const x = index % 4,
        y = Math.floor(index / 4);
      return rgba((y < 2 ? 0 : 20) + (x < 2 ? 10 : 20));
    });
  install(surfaces, 1, bitmap(4, 4, 2, quadrants));
  const sprite = new BurikoDisplaySprite(environment, surfaces, 0);
  sprite.setCoordinates(0, 0, 0x10000);
  assert.equal(
    sprite.configureAffineBlend({
      sourceSurface: 1,
      pivotX: 0,
      pivotY: 0,
      angle: 0,
      perspective: 1,
      pivotPolicy: 0,
      sampling: 0,
    }),
    0,
  );
  sprite.blendMode = 0x80;
  const reduced = bitmap(2, 2, 2, Array(4).fill(0));
  sprite.draw(reduced, rectangle(2, 2), 0);
  assert.deepEqual(
    pixels(reduced),
    [10, 20, 30, 40].map((value) => rgba(value)),
  );

  install(surfaces, 2, bitmap(64, 64, 2, Array(64 * 64).fill(rgba(33))));
  const dispatches = [],
    run = processing.run.bind(processing);
  processing.run = (distributed) => {
    dispatches.push(distributed);
    return run(distributed);
  };
  assert.equal(
    sprite.configureMesh({
      sourceSurface: 2,
      sourcePivotX: 40,
      sourcePivotY: 40,
      pitch: 0,
      heading: 0,
      bank: 0,
      rotationOrder: 0,
      perspective: 0,
      pivotPolicy: 0,
      sampling: 0,
    }),
    0,
  );
  const mesh = bitmap(64, 64, 2, Array(64 * 64).fill(0));
  sprite.draw(mesh, rectangle(64, 64), 0);
  assert.deepEqual(dispatches, [1, 1]);
  assert.deepEqual(pixels(mesh), Array(64 * 64).fill(rgba(33)));
});

test('mode-five fractional origin reaches affine sampling while mode two ignores its stale phase', () => {
  const {environment, surfaces} = fixture();
  install(surfaces, 1, bitmap(2, 2, 2, [rgba(16), rgba(32), rgba(48), rgba(64)]));
  const sprite = new BurikoDisplaySprite(environment, surfaces, 0);
  sprite.setCoordinates(0x8000, 0, 0);
  assert.equal(
    sprite.configureAffineBlend({
      sourceSurface: 1,
      pivotX: 0,
      pivotY: 0,
      angle: 0,
      perspective: 0,
      pivotPolicy: 0,
      sampling: 1,
    }),
    0,
  );
  sprite.blendMode = 0x80;
  const fractional = bitmap(2, 2, 2, Array(4).fill(0));
  sprite.draw(fractional, rectangle(2, 2), 0);
  assert.deepEqual(pixels(fractional), [rgba(8, 127), rgba(24), rgba(24, 127), rgba(56)]);

  assert.equal(
    sprite.configureAffine({
      sourceSurface: 1,
      pivotX: 0,
      pivotY: 0,
      angle: 0,
      scaleX: 0x10000,
      scaleY: 0x10000,
      sampling: 1,
    }),
    0,
  );
  const integral = bitmap(2, 2, 2, Array(4).fill(0));
  sprite.draw(integral, rectangle(2, 2), 0);
  assert.deepEqual(pixels(integral), [rgba(16), rgba(32), rgba(48), rgba(64)]);
});

test('explicit source-region notification records simple damage and refreshes mode-five mipmaps', () => {
  const {environment, surfaces} = fixture(),
    manager = new BurikoDisplayManager(
      environment,
      surfaces,
      new BurikoNativeDisplayState(1920, 1080),
    ),
    handle = manager.createSprite(),
    sprite = manager.find('sprite', handle),
    quadrants = Array.from({length: 16}, (_, index) => {
      const x = index % 4,
        y = Math.floor(index / 4);
      return rgba((y < 2 ? 0 : 20) + (x < 2 ? 10 : 20));
    });
  assert.ok(sprite instanceof BurikoDisplaySprite);
  install(surfaces, 1, bitmap(4, 4, 2, quadrants));
  assert.equal(sprite.configureSimple(1), 0);
  assert.equal(manager.notifySpriteSourceRegionChanged(handle, 1, 1, 2, 2), 0);
  assert.deepEqual(
    environment.damage.snapshot().map(({rectangle: value}) => value),
    [{left: 1, top: 1, right: 2, bottom: 2}],
  );
  environment.damage.clear();
  assert.equal(manager.notifySpriteSourceRegionChanged(handle, 3, 4, 0, 1), 10);
  assert.deepEqual(environment.damage.snapshot(), []);

  sprite.setCoordinates(0, 0, 0x10000);
  assert.equal(
    sprite.configureAffineBlend({
      sourceSurface: 1,
      pivotX: 0,
      pivotY: 0,
      angle: 0,
      perspective: 1,
      pivotPolicy: 0,
      sampling: 0,
    }),
    0,
  );
  const source = surfaces.descriptor(1);
  for (const index of [0, 1, 4, 5]) source.storage.view.setUint32(index * 4, rgba(50), true);
  source.storage.written(0, source.storage.bytes.length);
  assert.equal(manager.notifySpriteSourceRegionChanged(handle, 0, 0, 2, 2), 0);
  const reduced = bitmap(2, 2, 2, Array(4).fill(0));
  sprite.blendMode = 0x80;
  sprite.draw(reduced, rectangle(2, 2), 0);
  assert.deepEqual(
    pixels(reduced),
    [50, 20, 30, 40].map((value) => rgba(value)),
  );
});

test('Bank 90:53 preserves five-pop order and its two exact status diagnostics', async () => {
  const {environment, surfaces} = fixture(),
    manager = new BurikoDisplayManager(
      environment,
      surfaces,
      new BurikoNativeDisplayState(1920, 1080),
    ),
    handle = manager.createSprite(),
    sprite = manager.find('sprite', handle),
    messages = [],
    slots = createGroup90SpriteNotifications(manager, {
      files: {
        text: {
          encodeWide(message) {
            messages.push(message);
            return new Uint8Array();
          },
        },
      },
      threadFatal() {
        return Promise.reject(new Error('sprite notification fatal'));
      },
    }),
    slot = slots[0],
    thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    context = {thread, memory: new BurikoBpMemory(new Uint8Array(0)), diagnostics: {}};
  assert.ok(sprite instanceof BurikoDisplaySprite);
  install(surfaces, 1, bitmap(4, 4, 2, Array(16).fill(rgba(7))));
  assert.equal(sprite.configureSimple(1), 0);
  assert.deepEqual(
    [slot.primary, slot.secondary, slot.nativeAddress],
    [0x90, 0x53, BURIKO_NATIVE_SLOT_ADDRESSES[0x90][0x53]],
  );
  const call = (values) => {
    const before = thread.stackIndex;
    for (const value of values) push32(thread, value);
    const result = slot.execute(context);
    assert.equal(thread.stackIndex, before);
    return result;
  };
  assert.equal(await call([handle, 1, 2, 2, 1]), 0);
  assert.deepEqual(
    environment.damage.snapshot().map(({rectangle: value}) => value),
    [{left: 1, top: 2, right: 2, bottom: 2}],
  );
  environment.damage.clear();
  await assert.rejects(call([handle, 1, 2, 0, 1]), /sprite notification fatal/);
  assert.equal(messages.pop(), '無効な更新領域情報が指定されました');
  await assert.rejects(call([0x80000001, 1, 2, 1, 1]), /sprite notification fatal/);
  assert.equal(messages.pop(), '無効なスプライトハンドルが指定されました');
});

test('Bank 90:56-5D configures all seven sprite modes through the shared manager', async () => {
  const {environment, surfaces} = fixture(),
    manager = new BurikoDisplayManager(
      environment,
      surfaces,
      new BurikoNativeDisplayState(1920, 1080),
    ),
    handle = manager.createSprite(),
    sprite = manager.find('sprite', handle);
  assert.ok(sprite instanceof BurikoDisplaySprite);
  install(surfaces, 1, bitmap(8, 8, 2, Array(64).fill(rgba(11))));
  install(surfaces, 2, bitmap(8, 8, 2, Array(64).fill(rgba(22))));
  install(surfaces, 3, bitmap(8, 8, 2, Array(64).fill(rgba(33))));
  install(surfaces, 4, bitmap(8, 8, 3, Array(64).fill(128)));
  zeroMap(surfaces, 5, 8, 8);
  assert.equal(surfaces.coefficientTables.configureRipple(1, 1, 256, 1, 1), 0);

  const slots = createGroup90SpriteConfiguration(manager, {
      files: {
        text: {
          encodeWide() {
            assert.fail('ordinary sprite configuration should not encode a fatal diagnostic');
          },
        },
      },
      threadFatal() {
        assert.fail('ordinary sprite configuration should not raise a thread error');
      },
    }),
    bySecondary = new Map(slots.map((slot) => [slot.secondary, slot])),
    thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 64,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    context = {thread, memory: new BurikoBpMemory(new Uint8Array(0)), diagnostics: {}};
  assert.deepEqual(
    slots.map(({primary, secondary, nativeAddress}) => [primary, secondary, nativeAddress]),
    Array.from({length: 8}, (_, index) => {
      const secondary = 0x56 + index;
      return [0x90, secondary, BURIKO_NATIVE_SLOT_ADDRESSES[0x90][secondary]];
    }),
  );

  let invalidations = 0,
    resorts = 0;
  const invalidate = sprite.invalidate.bind(sprite),
    resort = manager.lists.resort.bind(manager.lists);
  sprite.invalidate = () => {
    invalidations++;
    invalidate();
  };
  manager.lists.resort = (object) => {
    resorts++;
    return resort(object);
  };
  sprite.setActivation(1);
  async function call(secondary, values) {
    const before = thread.stackIndex;
    for (const value of values) push32(thread, value);
    assert.equal(await bySecondary.get(secondary).execute(context), 0);
    assert.equal(thread.stackIndex, before);
  }

  await call(0x56, [handle, 3, 4, 1, 0x80, 12, 7]);
  assert.deepEqual(
    [
      sprite.mode,
      sprite.sourceSurface,
      sprite.position(),
      sprite.blendMode,
      sprite.getBlendValue(),
      sprite.getLayer(),
    ],
    [0, 1, {x: 3, y: 4}, 0x80, 12, 7],
  );

  await call(0x57, [handle, 2]);
  assert.deepEqual(
    [sprite.mode, sprite.sourceSurface, sprite.position(), sprite.getLayer(), resorts],
    [0, 2, {x: 3, y: 4}, 7, 1],
  );

  await call(0x58, [handle, 5, 6, 1, 3, 128, 17, 8, 2]);
  assert.deepEqual(
    [
      sprite.mode,
      sprite.sourceSurface,
      sprite.secondarySurface,
      sprite.mixValue,
      sprite.blendSelector,
    ],
    [1, 1, 3, 128, 2],
  );
  assert.deepEqual(
    [sprite.position(), sprite.blendMode, sprite.getBlendValue(), sprite.getLayer()],
    [{x: 5, y: 6}, 1, 17, 8],
  );

  await call(0x59, [handle, 7, 8, 1, 2, 3, 0, 0x10000, 0x10000, 0, 0x80, 18, 9]);
  assert.deepEqual(
    [
      sprite.mode,
      sprite.sourceSurface,
      sprite.position(),
      sprite.blendMode,
      sprite.getBlendValue(),
      sprite.getLayer(),
    ],
    [2, 1, {x: 7, y: 8}, 0x80, 18, 9],
  );

  await call(0x5a, [handle, 9, 10, 1, 4, 256, 1, 0x80, 19, 10]);
  assert.deepEqual(
    [
      sprite.mode,
      sprite.sourceSurface,
      sprite.revealExponent,
      sprite.getValueD8(0),
      sprite.position(),
      sprite.blendMode,
      sprite.getBlendValue(),
      sprite.getLayer(),
    ],
    [3, 1, 256, 1, {x: 9, y: 10}, 0x80, 19, 10],
  );

  await call(0x5b, [handle, 11, 12, 1, 5, 1, 1, 256, 20, 11]);
  assert.deepEqual(
    [
      sprite.mode,
      sprite.sourceSurface,
      sprite.displacementMapSurface,
      sprite.position(),
      sprite.blendMode,
      sprite.getBlendValue(),
      sprite.transparency,
      sprite.getLayer(),
    ],
    [4, 1, 5, {x: 11, y: 12}, 1, 256, 20, 11],
  );

  await call(0x5c, [
    handle,
    0x10000,
    0x20000,
    0,
    1,
    0xffffffff,
    128,
    2,
    2,
    3,
    0,
    0,
    0,
    0,
    0x80,
    21,
    12,
  ]);
  assert.deepEqual(
    [
      sprite.mode,
      sprite.sourceSurface,
      sprite.secondarySurface,
      sprite.mixValue,
      sprite.blendSelector,
      sprite.positionUsesCoordinates,
      sprite.coordinates(),
      sprite.blendMode,
      sprite.getBlendValue(),
      sprite.getLayer(),
    ],
    [5, 1, -1, 0, -1, 0, {x: 0x10000, y: 0x20000, z: 0}, 0x80, 21, 12],
  );

  await call(0x5d, [
    handle,
    0x30000,
    0x40000,
    0,
    1,
    3,
    128,
    2,
    2,
    3,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0x80,
    22,
    13,
  ]);
  assert.deepEqual(
    [
      sprite.mode,
      sprite.sourceSurface,
      sprite.secondarySurface,
      sprite.mixValue,
      sprite.blendSelector,
      sprite.positionUsesCoordinates,
      sprite.coordinates(),
      sprite.blendMode,
      sprite.getBlendValue(),
      sprite.getLayer(),
      invalidations,
      resorts,
    ],
    [6, 1, 3, 128, 2, 0, {x: 0x30000, y: 0x40000, z: 0}, 0x80, 22, 13, 16, 7],
  );
});

test('fused blend preserves destination pairs and odd tails when both mixed alphas are zero', () => {
  const destinationValues = [0xa10b0c0d, 0xb11b1c1d, 0xc12b2c2d],
    destination = bitmap(3, 1, 1, destinationValues),
    first = bitmap(3, 1, 2, [0x00102030, 0x00405060, 0x00708090]),
    second = bitmap(3, 1, 2, [0x0090a0b0, 0x00c0d0e0, 0x00112233]);
  assert.equal(blendMixedBurikoBitmapsIntoRgb(destination, first, second, 128, 0), 0);
  assert.deepEqual(pixels(destination), destinationValues);
});
