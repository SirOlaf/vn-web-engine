import {allocateBurikoBitmap, fillBurikoBitmap} from '../dist/engines/buriko/native/bitmap.js';
import {BurikoDisplaySprite} from '../dist/engines/buriko/native/display-sprite.js';
import {BurikoWindowDisplayState} from '../dist/engines/buriko/native/display-window-state.js';
import {BurikoWindowDisplayObject} from '../dist/engines/buriko/native/display-window.js';
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
import {createGroup90SpriteLifecycle} from '../dist/engines/buriko/native/group-90-sprite-lifecycle.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {BurikoSpriteTargets} from '../dist/engines/buriko/native/sprite-targets.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

test('Sprite and Window lifecycle wrappers share real pools, masks and input capture', () => {
  const compositor = new BurikoBitmapCompositor();
  compositor.defaultFormat = 1;
  const environment = new BurikoDisplayObjectEnvironment(
    compositor,
    new BurikoDisplayDamage(32, {left: 0, top: 0, right: 99, bottom: 99}),
  );
  const text = new BurikoNativeText();
  const surfaces = new BurikoSurfaces(
    new BurikoNativeFonts(text),
    compositor,
    new BurikoDistributedAllocator(1),
  );
  const display = new BurikoNativeDisplayState(100, 100);
  const manager = new BurikoDisplayManager(environment, surfaces, display);
  const output = allocateBurikoBitmap(100, 100, 1);
  fillBurikoBitmap(output, 0);
  manager.bindDisplayContext({bitmap: output, bounds: {left: 0, top: 0, right: 99, bottom: 99}});
  const input = new BurikoNativeInput(display, {read: () => 0n});
  input.foreground = true;
  input.inputActive = true;
  input.pointerAvailable = true;
  input.touchPositions = [[1, 1]];
  input.resetCaptures();
  const targets = new BurikoSpriteTargets(manager, input);
  const definitions = createGroup90SpriteLifecycle(manager, targets, {
    files: {text},
    threadFatal() {
      assert.fail('ordinary lifecycle operation must succeed');
    },
  });
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory: new BurikoBpMemory(new Uint8Array(0)), diagnostics: {}};
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
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x90][slot.secondary]);
  assert.equal(surfaces.allocate(0, 4, 4, 1), 1);
  fillBurikoBitmap(surfaces.snapshot(0), 0x204060);
  assert.equal(surfaces.allocate(1, 4, 4, 3), 1);
  const mask = surfaces.snapshot(1);
  mask.storage.bytes.fill(255);
  mask.storage.written(0, mask.storage.bytes.length);
  const handle = call(0x50, [], 1);
  const sprite = manager.find('sprite', handle);
  assert.ok(sprite instanceof BurikoDisplaySprite);
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
  const state = new BurikoWindowDisplayState(manager);
  const created = manager.createConfigured(
    'window',
    (order) => new BurikoWindowDisplayObject(state, order),
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
