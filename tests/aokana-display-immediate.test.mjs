import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {BurikoDisplayObjectEnvironment} from '../dist/engines/buriko/native/display-object.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {createGroup90DisplayImmediate} from '../dist/engines/buriko/native/group-90-display-immediate.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

test('immediate object wrappers mutate shared sprites, propagate children, damage and resort', () => {
  const text = new BurikoNativeText(),
    compositor = new BurikoBitmapCompositor(),
    allocator = new BurikoDistributedAllocator(1),
    surfaces = new BurikoSurfaces(new BurikoNativeFonts(text), compositor, allocator),
    damage = new BurikoDisplayDamage(64, {left: 0, top: 0, right: 127, bottom: 127}),
    manager = new BurikoDisplayManager(
      new BurikoDisplayObjectEnvironment(compositor, damage),
      surfaces,
      new BurikoNativeDisplayState(128, 128),
    ),
    thread = new BurikoBpThread({id: 1, operandCapacity: 32, moduleCapacity: 0, frameCapacity: 0}),
    context = {thread, memory: new BurikoBpMemory(new Uint8Array(0)), diagnostics: {}},
    slots = createGroup90DisplayImmediate(manager, {
      files: {text},
      threadFatal() {
        assert.fail('ordinary display operation should succeed');
      },
    });
  surfaces.allocate(0, 4, 4, 1);
  surfaces.fill(0, 0x112233);
  const handle = manager.createSprite(),
    otherHandle = manager.createSprite(),
    sprite = manager.resolve(handle),
    other = manager.resolve(otherHandle);
  assert.equal(manager.initializeSimpleSprite(handle, 2, 3, 0, 0x80, 256, 2), 0);
  assert.equal(manager.initializeSimpleSprite(otherHandle, 12, 13, 0, 0x80, 256, 4), 0);
  assert.equal(sprite.addChild(other, 0, 0), 1);
  for (const slot of slots)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x90][slot.secondary]);
  const call = (secondary, ...args) => {
    args.forEach((value) => push32(thread, value));
    assert.equal(slots.find((slot) => slot.secondary === secondary).execute(context), 0);
    assert.equal(thread.stackIndex, 0);
  };
  call(0x30, handle, 1);
  assert.equal(sprite.inputActive(), 1);
  assert.equal(other.inputActive(), 1);
  damage.clear();
  call(0x33, handle, 20, 30);
  assert.deepEqual(sprite.position(), {x: 20, y: 30});
  assert.ok(damage.fullRedraw !== 0 || damage.snapshot().length > 0);
  call(0x36, handle, -2, 3);
  call(0x37, handle, 4, -5);
  assert.deepEqual(sprite.getSecondaryOffset(), {x: -2, y: 3});
  assert.deepEqual(other.getSecondaryOffset(), {x: -2, y: 3});
  assert.deepEqual(sprite.getOffset(), {x: 4, y: -5});
  assert.deepEqual(other.getOffset(), {x: 4, y: -5});
  call(0x32, handle, 128);
  assert.equal(sprite.getBlendValue(), 128);
  assert.equal(other.getBlendValue(), 128);
  call(0x35, handle, 7);
  assert.equal(sprite.getValueD8(0), 7);
  assert.equal(other.getValueD8(0), 7);
  call(0x34, handle, 256);
  assert.equal(sprite.inputActive(), 0);
  assert.equal(other.inputActive(), 0);
  call(0x34, handle, 0);
  call(0x39, handle, 64);
  assert.equal(sprite.opacityScale, 64);
  assert.equal(other.opacityScale, 64);
  call(0x38, handle, 0xc0, 1, 0);
  call(0x31, handle, 0);
  assert.equal(sprite.inputActive(), 0);
  assert.equal(other.inputActive(), 0);
  call(0x31, handle, 1);
  assert.equal(sprite.inputActive(), 1);
  call(0x3a, handle, 6);
  assert.equal(sprite.getLayer(), 6);
  assert.deepEqual(
    manager.lists.snapshot(false).map((entry) => entry.object.handle),
    [0, otherHandle, handle],
  );
  call(0x3a, handle, 2);
  assert.deepEqual(
    manager.lists.snapshot(false).map((entry) => entry.object.handle),
    [0, handle, otherHandle],
  );
  call(0x38, handle, 0x8100, 9, 0);
  assert.equal(
    manager.lists.snapshot(false).find((entry) => entry.object === sprite).key,
    sprite.sortKey(),
  );
  call(0x30, handle, 0);
  assert.equal(sprite.inputActive(), 0);
  assert.equal(other.inputActive(), 0);
});
