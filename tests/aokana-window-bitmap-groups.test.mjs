import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, push32, pop32} from '../dist/engines/buriko/bp/state.js';
import {allocateBurikoBitmap} from '../dist/engines/buriko/native/bitmap.js';
import {bitmapRead32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {BurikoDisplayObjectEnvironment} from '../dist/engines/buriko/native/display-object.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoWindowDisplayObject} from '../dist/engines/buriko/native/display-window.js';
import {BurikoWindowDisplayState} from '../dist/engines/buriko/native/display-window-state.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {createGroup90WindowBitmapGroups} from '../dist/engines/buriko/native/group-90-window-bitmap-groups.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';

test('90:B7 composes real inner Sprites from VM bitmap groups and replaces the ordinary scene', () => {
  const compositor = new BurikoBitmapCompositor();
  compositor.defaultFormat = 1;
  const surfaces = new BurikoSurfaces(
    new BurikoNativeFonts(new BurikoNativeText()),
    compositor,
    new BurikoDistributedAllocator(1),
  );
  const bounds = {left: 0, top: 0, right: 63, bottom: 31},
    environment = new BurikoDisplayObjectEnvironment(
      compositor,
      new BurikoDisplayDamage(128, bounds),
    ),
    manager = new BurikoDisplayManager(environment, surfaces, new BurikoNativeDisplayState(64, 32));
  manager.bindDisplayContext({bitmap: allocateBurikoBitmap(64, 32, 1), bounds});
  const windows = new BurikoWindowDisplayState(manager),
    created = manager.createConfigured(
      'window',
      (order) => new BurikoWindowDisplayObject(windows, order),
      (window) => window.configureInitial(32, 24),
    );
  assert.equal(created.result, 0);
  const window = manager.find('window', created.handle);
  for (const [id, color] of [
    [0, 0x800000],
    [1, 0x008000],
  ]) {
    assert.equal(surfaces.allocate(id, 4, 4, 1), 1);
    surfaces.fill(id, color);
  }
  const [slot] = createGroup90WindowBitmapGroups(manager),
    memory = new BurikoBpMemory(new Uint8Array(1024)),
    thread = new BurikoBpThread({id: 1, operandCapacity: 8, moduleCapacity: 0, frameCapacity: 0}),
    view = new DataView(memory.globalMemory.buffer);
  assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x90][0xb7]);
  const words = (offset, values) =>
    values.forEach((v, i) => view.setInt32(offset + i * 4, v, true));
  words(32, [1, 128, 0, 0, 0, 0, 0, 0, 0, 0]);
  words(128, [3, 3, 256, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  for (let i = 0; i < 3; i++) {
    const unit = Array(49).fill(0);
    // Immediate drawing uses visibility, not the independent hit-validity field.
    unit[0] = 0;
    unit[1] = 1;
    unit[2] = 2 + i * 8;
    unit[3] = 3;
    unit[4] = unit[5] = 1;
    unit[8] = 0;
    unit[10] = 1;
    unit[48] = i === 2 ? 0x40 : i === 1 ? 2 : 0;
    words(256 + i * 0xc4, unit);
  }
  const draw = () => {
    push32(thread, created.handle);
    push32(thread, 32);
    assert.equal(slot.execute({thread, memory, diagnostics: {}}), 0);
    assert.equal(pop32(thread), 0);
    assert.equal(thread.stackIndex, 0);
  };
  const pixel = (x, y) => {
    const bitmap = window.compositionBitmap;
    return bitmapRead32(bitmap, bitmap.offset + y * bitmap.stride + x * 4) & 0xffffff;
  };
  // Zero rotation/unit scale and pivot(1,1) cancel the passed origin additions.
  // Selected unit1 uses green; unit2's40 flag suppresses inner-Sprite creation.
  draw();
  assert.deepEqual([pixel(3, 4), pixel(11, 4), pixel(19, 4)], [0x800000, 0x008000, 0]);
  view.setInt32(128 + 3 * 4, 0, true);
  draw();
  assert.deepEqual([pixel(3, 4), pixel(11, 4), pixel(19, 4)], [0x008000, 0x800000, 0]);
});
