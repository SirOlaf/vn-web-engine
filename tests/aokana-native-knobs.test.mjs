import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoDisplayKnob} from '../dist/engines/buriko/native/display-knob.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {
  BurikoDisplayObject,
  BurikoDisplayObjectEnvironment,
} from '../dist/engines/buriko/native/display-object.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {createGroup90Knobs} from '../dist/engines/buriko/native/group-90-knobs.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {BurikoKnobDisplays} from '../dist/engines/buriko/native/knob-displays.js';
import {BurikoNativeNotifications} from '../dist/engines/buriko/native/notification-queue.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

class KnobTarget extends BurikoDisplayObject {
  constructor(environment, creationOrder, x, y) {
    super(environment, 2, creationOrder, 1);
    assert.equal(this.configureGeometry(3, 2), 1);
    this.move(x, y);
    this.setLayer(2);
  }
}

function fixture() {
  const compositor = new BurikoBitmapCompositor();
  compositor.defaultFormat = 2;
  const bounds = {left: 0, top: 0, right: 99, bottom: 99},
    environment = new BurikoDisplayObjectEnvironment(
      compositor,
      new BurikoDisplayDamage(64, {...bounds}),
    );
  environment.displayContext = {
    bitmap: {
      storage: null,
      offset: 0,
      stride: 0,
      width: 100,
      height: 100,
      format: 2,
      bytesPerPixel: 4,
    },
    bounds,
  };
  const allocator = new BurikoDistributedAllocator(1),
    processing = new BurikoDistributedProcessing(allocator, 1),
    surfaces = new BurikoSurfaces(
      new BurikoNativeFonts(new BurikoNativeText()),
      compositor,
      allocator,
    ),
    display = new BurikoNativeDisplayState(1920, 1080);
  compositor.processing = processing;
  display.requestedWidth = display.logicalWidth;
  display.requestedHeight = display.logicalHeight;
  const manager = new BurikoDisplayManager(environment, surfaces, display),
    input = new BurikoNativeInput(display, {read: () => 0n}),
    notifications = new BurikoNativeNotifications(),
    knobs = new BurikoKnobDisplays(manager, input, notifications),
    failures = [],
    definitions = createGroup90Knobs(knobs, {
      files: {text: {encodeWide: (message) => message}},
      threadFatal: (_thread, _diagnostics, message) => {
        failures.push(message);
        throw new Error('native fatal');
      },
    }),
    bySecondary = new Map(definitions.map((definition) => [definition.secondary, definition])),
    thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 64,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    context = {
      thread,
      memory: new BurikoBpMemory(new Uint8Array(0)),
      diagnostics: {},
    },
    call = (secondary, arguments_) => {
      const definition = bySecondary.get(secondary);
      assert.ok(definition);
      arguments_.forEach((value) => push32(thread, value));
      assert.equal(definition.execute(context), 0);
    };
  return {definitions, environment, input, manager, knobs, notifications, thread, call};
}

test('Bank90 Knob wrappers preserve ordinary stack, target, list and interaction state', () => {
  const {definitions, environment, input, manager, knobs, notifications, thread, call} = fixture();
  assert.deepEqual(
    definitions.map((definition) => definition.secondary),
    [0xd0, 0xd1, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xdb, 0xdc, 0xdd, 0xde, 0xdf],
  );
  for (const definition of definitions)
    assert.equal(
      definition.nativeAddress,
      BURIKO_NATIVE_SLOT_ADDRESSES[0x90][definition.secondary],
    );

  const targetHandle = manager.createSimple(
      'sprite',
      (creationOrder) => new KnobTarget(environment, creationOrder, 10, 20),
    ),
    target = manager.find('sprite', targetHandle);
  assert.ok(target instanceof KnobTarget);

  call(0xd0, [targetHandle]);
  const handle = pop32(thread),
    knob = manager.find('knob', handle);
  assert.equal(handle, 0xf0000000);
  assert.ok(knob instanceof BurikoDisplayKnob);
  assert.equal(target.parent, knob);

  call(0xd4, [handle, 1]);
  call(0xd9, [handle, 13, 8]);
  call(0xd8, [handle, 6, 4]);
  call(0xd6, [handle, 3, 2]);
  assert.deepEqual(target.position(), {x: 16, y: 24});
  call(0xd5, [handle, 30, 40]);
  assert.deepEqual(target.position(), {x: 36, y: 44});
  call(0xd7, [handle]);
  assert.equal(pop32(thread), 2);
  assert.equal(pop32(thread), 3);

  call(0xdc, [handle, 1]);
  call(0xde, [handle]);
  call(0xdd, [9]);
  assert.equal(pop32(thread), 1);
  assert.equal(knobs.handleWheel(0), true);
  assert.equal(knobs.wheelModeValue(), 9);
  assert.deepEqual(knob.value(), {x: 3, y: 1});
  call(0xda, [handle]);
  assert.equal(pop32(thread), 0);

  input.foreground = true;
  input.pointerAvailable = true;
  input.pointerClientX = 37;
  input.pointerClientY = 42;
  const receiver = knobs.findPointerReceiver();
  assert.ok(receiver);
  assert.equal(receiver.id, handle);
  knobs.latchRightClick(receiver);
  call(0xdb, []);
  assert.equal(pop32(thread), handle);
  call(0xdb, []);
  assert.equal(pop32(thread), 0);

  knobs.beginPointerInteraction(receiver, 37, 42);
  assert.equal(knobs.currentPointerId(), handle);
  assert.deepEqual(notifications.take(), {type: 0x1000, value1: handle, value2: 0});
  input.setPhysicalKey(1, true);
  input.pointerClientX = 39;
  input.pointerClientY = 43;
  knobs.pollPointerInteraction();
  assert.equal(manager.redraw.pending, 1);
  assert.deepEqual(knob.value(), {x: 4, y: 2});
  input.setPhysicalKey(1, false);
  knobs.pollPointerInteraction();
  assert.equal(knobs.currentPointerId(), 0);
  assert.deepEqual(notifications.take(), {type: 0x1001, value1: handle, value2: 0});

  call(0xdf, [handle]);
  call(0xd1, [handle]);
  assert.equal(manager.find('knob', handle), null);
  assert.equal(target.parent, null);
  assert.equal(thread.stackIndex, 0);
});
