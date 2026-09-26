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
import {createGroup90DisplayHit} from '../dist/engines/buriko/native/group-90-display-hit.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {clearBurikoBitmap} from '../dist/engines/buriko/native/bitmap-copy.js';

test('object hit wrappers copy real surface masks and use logical pointer minus effective position', () => {
  const text = new BurikoNativeText(),
    compositor = new BurikoBitmapCompositor(),
    allocator = new BurikoDistributedAllocator(1),
    surfaces = new BurikoSurfaces(new BurikoNativeFonts(text), compositor, allocator),
    display = new BurikoNativeDisplayState(256, 256);
  display.setSizePreset(2, 128, 128);
  display.requestedWidth = display.requestedHeight = 256;
  const manager = new BurikoDisplayManager(
      new BurikoDisplayObjectEnvironment(
        compositor,
        new BurikoDisplayDamage(32, {left: 0, top: 0, right: 127, bottom: 127}),
      ),
      surfaces,
      display,
    ),
    input = new BurikoNativeInput(display, new BurikoNativeClock(() => 0)),
    thread = new BurikoBpThread({id: 1, operandCapacity: 32, moduleCapacity: 0, frameCapacity: 0}),
    context = {thread, memory: new BurikoBpMemory(new Uint8Array(0)), diagnostics: {}},
    slots = createGroup90DisplayHit(manager, input, {
      files: {text},
      threadFatal() {
        assert.fail('ordinary hit service should succeed');
      },
    });
  surfaces.allocate(0, 4, 2, 1);
  surfaces.fill(0, 0x224466);
  surfaces.allocate(1, 4, 2, 3);
  const mask = surfaces.descriptor(1);
  clearBurikoBitmap(mask);
  mask.storage.bytes[2] = 1;
  const handle = manager.createSprite(),
    sprite = manager.resolve(handle);
  assert.equal(manager.initializeSimpleSprite(handle, 10, 20, 0, 0x80, 256, 2), 0);
  sprite.setOffset(3, -2);
  sprite.setSecondaryOffset(-1, 4);
  assert.deepEqual(sprite.effectivePosition(), {x: 12, y: 22});
  input.pointerAvailable = true;
  input.pointerClientX = 28;
  input.pointerClientY = 44;
  for (const slot of slots)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x90][slot.secondary]);
  const assign = (source) => {
    push32(thread, handle);
    push32(thread, source);
    assert.equal(slots[0].execute(context), 0);
    assert.equal(thread.stackIndex, 0);
  };
  const hit = () => {
    push32(thread, handle);
    assert.equal(slots[1].execute(context), 0);
    const result = pop32(thread);
    assert.equal(thread.stackIndex, 0);
    return result;
  };
  assign(1);
  assert.equal(hit(), 4);
  clearBurikoBitmap(mask);
  assert.equal(hit(), 4); // Packed mask owns a copy of the source selection.
  input.pointerClientX = 30;
  assert.equal(hit(), 0);
  assign(0xffffffff);
  assert.equal(hit(), 1);
  input.pointerClientX = 32;
  assert.equal(hit(), 0); // Local x4 lies outside the4-pixel object.
  input.pointerClientX = 28;
  assign(0xfffffffe);
  assert.equal(hit(), 0);
  assign(0xffffffff);
  assert.equal(hit(), 1);
});
