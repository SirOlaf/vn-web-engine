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
import {createGroup90DisplayHit} from '../dist/engines/buriko/games/aokana/native/group-90-display-hit.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

import {AokanaNativeInput} from '../dist/engines/buriko/games/aokana/native/input.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {clearAokanaBitmap} from '../dist/engines/buriko/games/aokana/native/bitmap-copy.js';

test('object hit wrappers copy real surface masks and use logical pointer minus effective position', () => {
  const text = new AokanaNativeText(),
    compositor = new AokanaBitmapCompositor(),
    allocator = new AokanaDistributedAllocator(1),
    surfaces = new AokanaSurfaces(new AokanaNativeFonts(text), compositor, allocator),
    display = new AokanaNativeDisplayState(256, 256);
  display.setSizePreset(2, 128, 128);
  display.requestedWidth = display.requestedHeight = 256;
  const manager = new AokanaDisplayManager(
      new AokanaDisplayObjectEnvironment(
        compositor,
        new AokanaDisplayDamage(32, {left: 0, top: 0, right: 127, bottom: 127}),
      ),
      surfaces,
      display,
    ),
    input = new AokanaNativeInput(display, new AokanaNativeClock(() => 0)),
    thread = new AokanaBpThread({id: 1, operandCapacity: 32, moduleCapacity: 0, frameCapacity: 0}),
    context = {thread, memory: new AokanaBpMemory(new Uint8Array(0)), diagnostics: {}},
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
  clearAokanaBitmap(mask);
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
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x90][slot.secondary]);
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
  clearAokanaBitmap(mask);
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
