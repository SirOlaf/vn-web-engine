import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {BurikoDisplayGroup} from '../dist/engines/buriko/native/display-group.js';
import {BurikoDisplayObjectEnvironment} from '../dist/engines/buriko/native/display-object.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {createGroup90Groups} from '../dist/engines/buriko/native/group-90-groups.js';
import {createGroup91KnobPointer} from '../dist/engines/buriko/native/group-90-knobs.js';
import {BurikoGroupDisplays} from '../dist/engines/buriko/native/group-displays.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {BurikoKnobDisplays} from '../dist/engines/buriko/native/knob-displays.js';
import {BurikoNativeNotifications} from '../dist/engines/buriko/native/notification-queue.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

test('Group services share child propagation and the existing Knob pointer receiver', () => {
  const compositor = new BurikoBitmapCompositor();
  compositor.defaultFormat = 2;
  const environment = new BurikoDisplayObjectEnvironment(
    compositor,
    new BurikoDisplayDamage(64, {left: 0, top: 0, right: 99, bottom: 99}),
  );
  const surfaces = new BurikoSurfaces(
    new BurikoNativeFonts(new BurikoNativeText()),
    compositor,
    new BurikoDistributedAllocator(1),
  );
  const display = new BurikoNativeDisplayState(100, 100),
    manager = new BurikoDisplayManager(environment, surfaces, display);
  const groups = new BurikoGroupDisplays(manager),
    input = new BurikoNativeInput(display, {read: () => 0n}),
    notifications = new BurikoNativeNotifications(),
    knobs = new BurikoKnobDisplays(manager, input, notifications);
  const definitions = createGroup90Groups(groups, {
    files: {text: {encodeWide: (message) => message}},
    threadFatal() {
      assert.fail('ordinary Group operations should succeed');
    },
  });
  const pointer = createGroup91KnobPointer(knobs)[0];
  const thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 32,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    context = {thread, memory: new BurikoBpMemory(new Uint8Array(0)), diagnostics: {}};
  const call = (secondary, args = [], pushed = 0) => {
    const depth = thread.stackIndex;
    args.forEach((value) => push32(thread, value));
    assert.equal(definitions.find((slot) => slot.secondary === secondary).execute(context), 0);
    assert.equal(thread.stackIndex, depth + pushed);
  };
  assert.deepEqual(
    definitions.map((slot) => slot.secondary),
    [0xe0, 0xe1, 0xe4, 0xe5, 0xe8, 0xe9],
  );
  for (const slot of [...definitions, pointer])
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[slot.primary][slot.secondary]);
  const firstHandle = manager.createSprite(),
    secondHandle = manager.createSprite(),
    first = manager.resolve(firstHandle),
    second = manager.resolve(secondHandle);
  first.configureGeometry(4, 4);
  second.configureGeometry(4, 4);
  call(0xe0, [], 1);
  const handle = pop32(thread),
    group = manager.find('group', handle);
  assert.equal(handle, 0xf1000000);
  assert.ok(group instanceof BurikoDisplayGroup);
  assert.equal(group.category, 9);
  assert.equal(manager.categoryCount(0x11), 1);
  assert.equal(
    manager.lists.snapshot(false).some((entry) => entry.object === group),
    false,
  );
  call(0xe8, [handle, firstHandle, 3, 5]);
  call(0xe8, [handle, secondHandle, 30, 35]);
  assert.equal(first.parent, group);
  assert.deepEqual(first.position(), {x: 3, y: 5});
  assert.deepEqual([...group.children()], [second, first]);
  call(0xe4, [handle, 1]);
  assert.deepEqual([group.activation, first.activation, second.activation], [1, 1, 1]);
  environment.damage.clear();
  call(0xe5, [handle, 10, 20, 64]);
  assert.deepEqual(first.position(), {x: 13, y: 25});
  assert.deepEqual(second.position(), {x: 40, y: 55});
  assert.deepEqual(
    [group.getBlendValue(), first.getBlendValue(), second.getBlendValue()],
    [64, 64, 64],
  );
  assert.ok(environment.damage.snapshot().length > 0);
  call(0xe9, [handle, firstHandle]);
  assert.equal(first.parent, null);
  call(0xe5, [handle, 11, 21, 80]);
  assert.deepEqual(first.position(), {x: 13, y: 25});
  assert.equal(first.getBlendValue(), 64);
  assert.deepEqual(second.position(), {x: 41, y: 56});
  assert.equal(second.getBlendValue(), 80);
  call(0xe9, [handle, secondHandle]);
  call(0xe1, [handle]);
  assert.equal(manager.categoryCount(0x11), 0);
  const readPointer = () => {
    const depth = thread.stackIndex;
    assert.equal(pointer.execute(context), 0);
    assert.equal(thread.stackIndex, depth + 1);
    return pop32(thread);
  };
  assert.equal(readPointer(), 0);
  const created = knobs.create(firstHandle);
  assert.equal(created.result, 0);
  knobs.setActivation(created.handle, 1);
  input.pointerAvailable = true;
  input.touchPositions = [[13, 25]];
  const receiver = knobs.findPointerReceiver();
  assert.ok(receiver);
  assert.equal(receiver.id, created.handle);
  knobs.beginPointerInteraction(receiver, 13, 25);
  assert.equal(readPointer(), created.handle);
  assert.equal(readPointer(), created.handle);
  assert.deepEqual(notifications.take(), {type: 0x1000, value1: created.handle, value2: 0});
  knobs.beginPointerInteraction(null, 0, 0);
  assert.equal(readPointer(), 0);
  assert.equal(thread.stackIndex, 0);
});
