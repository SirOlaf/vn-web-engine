import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {BurikoDisplayObjectEnvironment} from '../dist/engines/buriko/native/display-object.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {createGroup90SpriteTargets} from '../dist/engines/buriko/native/group-90-sprite-targets.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {BurikoSpriteTargets} from '../dist/engines/buriko/native/sprite-targets.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

test('Sprite targets retain shared-input poll state separately from newest geometric hits', () => {
  const compositor = new BurikoBitmapCompositor();
  compositor.defaultFormat = 2;
  const environment = new BurikoDisplayObjectEnvironment(
    compositor,
    new BurikoDisplayDamage(32, {left: 0, top: 0, right: 99, bottom: 99}),
  );
  const surfaces = new BurikoSurfaces(
    new BurikoNativeFonts(new BurikoNativeText()),
    compositor,
    new BurikoDistributedAllocator(1),
  );
  const display = new BurikoNativeDisplayState(100, 100),
    manager = new BurikoDisplayManager(environment, surfaces, display),
    input = new BurikoNativeInput(display, {read: () => 0n});
  input.foreground = true;
  input.inputActive = true;
  input.pointerAvailable = true;
  input.touchPositions = [[10, 10]];
  const targets = new BurikoSpriteTargets(manager, input);
  const definitions = createGroup90SpriteTargets(targets, {
    files: {text: {encodeWide: (message) => message}},
    threadFatal() {
      assert.fail('ordinary Sprite target operations should succeed');
    },
  });
  const thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    context = {thread, memory: new BurikoBpMemory(new Uint8Array(0)), diagnostics: {}};
  const call = (secondary, args = [], pushed = 0) => {
    const depth = thread.stackIndex;
    args.forEach((value) => push32(thread, value));
    assert.equal(definitions.find((slot) => slot.secondary === secondary).execute(context), 0);
    assert.equal(thread.stackIndex, depth + pushed);
    return pushed ? pop32(thread) : undefined;
  };
  assert.deepEqual(
    definitions.map((slot) => slot.secondary),
    [0xf8, 0xfa, 0xfb, 0xfc, 0xfd],
  );
  for (const slot of definitions)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x90][slot.secondary]);
  const firstHandle = manager.createSprite(),
    secondHandle = manager.createSprite(),
    first = manager.resolve(firstHandle),
    second = manager.resolve(secondHandle);
  for (const object of [first, second]) {
    object.configureGeometry(8, 8);
    object.move(8, 8);
  }
  first.setLayer(3);
  first.setActivation(1);
  second.setLayer(2);
  assert.equal(call(0xfc, [], 1), 0xffffffff);
  call(0xfa, [firstHandle]);
  call(0xfa, [secondHandle]);
  assert.equal(call(0xfc, [], 1), 1); // Inactive newest rectangle still wins this geometric-only query.
  assert.equal(call(0xfd, [0], 1), 0);
  assert.equal(call(0xfd, [1], 1), 0);
  input.setPhysicalKey(1, true);
  input.recordKeyDown(1);
  targets.poll();
  assert.equal(call(0xfd, [0], 1), 1);
  assert.equal(call(0xfd, [0], 1), 1);
  assert.equal(call(0xfd, [1], 1), 0);
  assert.equal(input.collect(0, first.sortKey()) & 1, 0);
  targets.poll();
  assert.equal(call(0xfd, [0], 1), 0);
  first.move(40, 40);
  second.setActivation(1);
  input.recordKeyDown(1);
  targets.poll();
  assert.equal(call(0xfd, [0], 1), 0);
  assert.equal(call(0xfd, [1], 1), 1);
  call(0xfb, [secondHandle]);
  assert.equal(call(0xfc, [], 1), 0xffffffff);
  call(0xfa, [secondHandle]);
  assert.equal(call(0xfc, [], 1), 2);
  assert.equal(call(0xfd, [2], 1), 0);
  call(0xf8);
  assert.equal(call(0xfc, [], 1), 0xffffffff);
  call(0xfa, [firstHandle]);
  input.touchPositions = [[40, 40]];
  assert.equal(call(0xfc, [], 1), 0);
  assert.equal(call(0xfd, [0], 1), 0);
  call(0xf8);
  assert.equal(thread.stackIndex, 0);
  assert.equal(targets.manager, manager);
  assert.equal(targets.input, input);
});
