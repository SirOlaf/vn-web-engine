import {
  allocateAokanaBitmap,
  fillAokanaBitmap,
} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {AokanaDisplaySprite} from '../dist/engines/buriko/games/aokana/native/display-sprite.js';
import {AokanaWindowDisplayState} from '../dist/engines/buriko/games/aokana/native/display-window-state.js';
import {AokanaWindowDisplayObject} from '../dist/engines/buriko/games/aokana/native/display-window.js';
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
import {createGroup90SpriteLifecycle} from '../dist/engines/buriko/games/aokana/native/group-90-sprite-lifecycle.js';
import {AokanaNativeInput} from '../dist/engines/buriko/games/aokana/native/input.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {AokanaSpriteTargets} from '../dist/engines/buriko/games/aokana/native/sprite-targets.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

test('Sprite and Window lifecycle wrappers share real pools, masks and input capture', () => {
  const compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 1;
  const environment = new AokanaDisplayObjectEnvironment(
    compositor,
    new AokanaDisplayDamage(32, {left: 0, top: 0, right: 99, bottom: 99}),
  );
  const text = new AokanaNativeText();
  const surfaces = new AokanaSurfaces(
    new AokanaNativeFonts(text),
    compositor,
    new AokanaDistributedAllocator(1),
  );
  const display = new AokanaNativeDisplayState(100, 100);
  const manager = new AokanaDisplayManager(environment, surfaces, display);
  const output = allocateAokanaBitmap(100, 100, 1);
  fillAokanaBitmap(output, 0);
  manager.bindDisplayContext({bitmap: output, bounds: {left: 0, top: 0, right: 99, bottom: 99}});
  const input = new AokanaNativeInput(display, {read: () => 0n});
  input.foreground = true;
  input.inputActive = true;
  input.pointerAvailable = true;
  input.touchPositions = [[1, 1]];
  input.resetCaptures();
  const targets = new AokanaSpriteTargets(manager, input);
  const definitions = createGroup90SpriteLifecycle(manager, targets, {
    files: {text},
    threadFatal() {
      assert.fail('ordinary lifecycle operation must succeed');
    },
  });
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: new AokanaBpMemory(new Uint8Array(0)), diagnostics: {}};
  const call = (secondary, args = [], pushed = 0) => {
    args.forEach((value) => push32(thread, value));
    assert.equal(definitions.find((slot) => slot.secondary === secondary).execute(context), 0);
    assert.equal(thread.stackIndex, pushed);
    return pushed ? pop32(thread) : undefined;
  };
  assert.deepEqual(
    definitions.map((slot) => slot.secondary),
    [0x50, 0x51, 0x54, 0x55, 0x81],
  );
  for (const slot of definitions)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x90][slot.secondary]);
  assert.equal(surfaces.allocate(0, 4, 4, 1), 1);
  fillAokanaBitmap(surfaces.snapshot(0), 0x204060);
  assert.equal(surfaces.allocate(1, 4, 4, 3), 1);
  const mask = surfaces.snapshot(1);
  mask.storage.bytes.fill(255);
  mask.storage.written(0, mask.storage.bytes.length);
  const handle = call(0x50, [], 1);
  const sprite = manager.find('sprite', handle);
  assert.ok(sprite instanceof AokanaDisplaySprite);
  assert.equal(sprite.initializeSimple(0, 0, 0, 0, 0, 3), 0);
  assert.equal(manager.poolObjects('sprite').filter(Boolean).length, 1);
  call(0x54, [handle, 1]);
  assert.equal(sprite.inputActive(), 1);
  call(0x54, [handle, 0]);
  assert.equal(sprite.inputActive(), 0);
  call(0x54, [handle, 1]);
  call(0x55, [handle, 1]);
  assert.equal(sprite.staticMaskSurface, 1);
  assert.equal(targets.register(handle), true);
  assert.equal(targets.hitTarget(), 0);
  assert.equal(input.pointerCaptureAllowed(1), false);
  call(0x51, [handle]);
  assert.equal(manager.poolObjects('sprite').filter(Boolean).length, 0);
  assert.equal(
    manager.lists.snapshot(false).some((entry) => entry.object.handle === handle),
    false,
  );
  assert.equal(targets.hitTarget(), 0xffffffff);
  assert.equal(input.pointerCaptureAllowed(1), true);
  const state = new AokanaWindowDisplayState(manager);
  const created = manager.createConfigured(
    'window',
    (order) => new AokanaWindowDisplayObject(state, order),
    (window) => window.configureInitial(2, 1),
  );
  assert.equal(created.result, 0);
  assert.equal(manager.poolObjects('window').filter(Boolean).length, 1);
  call(0x81, [created.handle]);
  assert.equal(manager.poolObjects('window').filter(Boolean).length, 0);
  assert.equal(
    manager.lists.snapshot(false).some((entry) => entry.object.handle === created.handle),
    false,
  );
  assert.equal(thread.stackIndex, 0);
});
