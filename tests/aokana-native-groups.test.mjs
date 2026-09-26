import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayGroup} from '../dist/engines/buriko/games/aokana/native/display-group.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {createGroup90Groups} from '../dist/engines/buriko/games/aokana/native/group-90-groups.js';
import {createGroup91KnobPointer} from '../dist/engines/buriko/games/aokana/native/group-90-knobs.js';
import {AokanaGroupDisplays} from '../dist/engines/buriko/games/aokana/native/group-displays.js';
import {AokanaNativeInput} from '../dist/engines/buriko/games/aokana/native/input.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {AokanaKnobDisplays} from '../dist/engines/buriko/games/aokana/native/knob-displays.js';
import {AokanaNativeNotifications} from '../dist/engines/buriko/games/aokana/native/notification-queue.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

test('Group services share child propagation and the existing Knob pointer receiver', () => {
  const compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 2;
  const environment = new AokanaDisplayObjectEnvironment(
    compositor,
    new AokanaDisplayDamage(64, {left: 0, top: 0, right: 99, bottom: 99}),
  );
  const surfaces = new AokanaSurfaces(
    new AokanaNativeFonts(new AokanaNativeText()),
    compositor,
    new AokanaDistributedAllocator(1),
  );
  const display = new AokanaNativeDisplayState(100, 100),
    manager = new AokanaDisplayManager(environment, surfaces, display);
  const groups = new AokanaGroupDisplays(manager),
    input = new AokanaNativeInput(display, {read: () => 0n}),
    notifications = new AokanaNativeNotifications(),
    knobs = new AokanaKnobDisplays(manager, input, notifications);
  const definitions = createGroup90Groups(groups, {
    files: {text: {encodeWide: (message) => message}},
    threadFatal() {
      assert.fail('ordinary Group operations should succeed');
    },
  });
  const pointer = createGroup91KnobPointer(knobs)[0];
  const thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 32,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    context = {thread, memory: new AokanaBpMemory(new Uint8Array(0)), diagnostics: {}};
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
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[slot.primary][slot.secondary]);
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
  assert.ok(group instanceof AokanaDisplayGroup);
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
