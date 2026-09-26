import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {createGroup90DisplayImmediate} from '../dist/engines/buriko/games/aokana/native/group-90-display-immediate.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

test('immediate object wrappers mutate shared sprites, propagate children, damage and resort', () => {
  const text = new AokanaNativeText(),
    compositor = new AokanaBitmapCompositor(),
    allocator = new AokanaDistributedAllocator(1),
    surfaces = new AokanaSurfaces(new AokanaNativeFonts(text), compositor, allocator),
    damage = new AokanaDisplayDamage(64, {left: 0, top: 0, right: 127, bottom: 127}),
    manager = new AokanaDisplayManager(
      new AokanaDisplayObjectEnvironment(compositor, damage),
      surfaces,
      new AokanaNativeDisplayState(128, 128),
    ),
    thread = new AokanaBpThread({id: 1, operandCapacity: 32, moduleCapacity: 0, frameCapacity: 0}),
    context = {thread, memory: new AokanaBpMemory(new Uint8Array(0)), diagnostics: {}},
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
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x90][slot.secondary]);
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
