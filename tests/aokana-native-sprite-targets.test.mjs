import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {createGroup90SpriteTargets} from '../dist/engines/buriko/games/aokana/native/group-90-sprite-targets.js';
import {AokanaNativeInput} from '../dist/engines/buriko/games/aokana/native/input.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {AokanaSpriteTargets} from '../dist/engines/buriko/games/aokana/native/sprite-targets.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

test('Sprite targets retain shared-input poll state separately from newest geometric hits', () => {
  const compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 2;
  const environment = new AokanaDisplayObjectEnvironment(
    compositor,
    new AokanaDisplayDamage(32, {left: 0, top: 0, right: 99, bottom: 99}),
  );
  const surfaces = new AokanaSurfaces(
    new AokanaNativeFonts(new AokanaNativeText()),
    compositor,
    new AokanaDistributedAllocator(1),
  );
  const display = new AokanaNativeDisplayState(100, 100),
    manager = new AokanaDisplayManager(environment, surfaces, display),
    input = new AokanaNativeInput(display, {read: () => 0n});
  input.foreground = true;
  input.inputActive = true;
  input.pointerAvailable = true;
  input.touchPositions = [[10, 10]];
  const targets = new AokanaSpriteTargets(manager, input);
  const definitions = createGroup90SpriteTargets(targets, {
    files: {text: {encodeWide: (message) => message}},
    threadFatal() {
      assert.fail('ordinary Sprite target operations should succeed');
    },
  });
  const thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    context = {thread, memory: new AokanaBpMemory(new Uint8Array(0)), diagnostics: {}};
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
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x90][slot.secondary]);
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
