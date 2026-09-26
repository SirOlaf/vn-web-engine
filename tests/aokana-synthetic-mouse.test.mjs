import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {BurikoDisplayObjectEnvironment} from '../dist/engines/buriko/native/display-object.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {createGroup81SyntheticMouse} from '../dist/engines/buriko/native/group-81-synthetic-mouse.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {BurikoKnobDisplays} from '../dist/engines/buriko/native/knob-displays.js';
import {BurikoMainWindowMessageReceiver} from '../dist/engines/buriko/native/main-window-messages.js';
import {BurikoNativeNotifications} from '../dist/engines/buriko/native/notification-queue.js';
import {BurikoWindowMessages as BurikoWaitWindowMessages} from '../dist/engines/buriko/native/procedure.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoSyntheticMouse} from '../dist/engines/buriko/native/synthetic-mouse.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoWindowMessages} from '../dist/engines/buriko/native/window-messages.js';

function fixture() {
  const compositor = new BurikoBitmapCompositor();
  compositor.defaultFormat = 2;
  const bounds = {left: 0, top: 0, right: 799, bottom: 599},
    environment = new BurikoDisplayObjectEnvironment(
      compositor,
      new BurikoDisplayDamage(64, {...bounds}),
    );
  environment.displayContext = {
    bitmap: {
      storage: null,
      offset: 0,
      stride: 0,
      width: 800,
      height: 600,
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
    messages = new BurikoWindowMessages(input),
    waits = new BurikoWaitWindowMessages(),
    order = [],
    focus = {focus: () => order.push('focus')};
  messages.createMainTarget();
  new BurikoMainWindowMessageReceiver(messages, waits, input, notifications, focus, knobs);
  const mouse = new BurikoSyntheticMouse(input, messages),
    [definition] = createGroup81SyntheticMouse(mouse),
    thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    context = {
      thread,
      memory: new BurikoBpMemory(new Uint8Array(0)),
      diagnostics: {},
    };
  return {definition, input, messages, notifications, order, thread, context, waits};
}

test('81:1E synchronously sends exact left and X2 pairs through the shared receiver', () => {
  const s = fixture(),
    waiter = new BurikoBpThread({
      id: 2,
      operandCapacity: 4,
      moduleCapacity: 0,
      frameCapacity: 0,
    });
  assert.equal(s.definition.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x81][0x1e]);
  for (const message of [0x201, 0x202, 0x20b, 0x20c]) s.waits.register(waiter, message);

  const queries = [],
    dispatch = s.waits.dispatch.bind(s.waits),
    saveClick = s.input.recordClickPosition.bind(s.input),
    mainTarget = s.messages.mainTarget.bind(s.messages);
  let cursorReads = 0,
    targetReads = 0;
  s.input.asynchronousKeyState = (key) => {
    queries.push(key);
    return key === 0x11 || key === 0x10 ? 0x8000 : 0;
  };
  s.input.pointerScreenX = 0x12345;
  s.input.pointerScreenY = -2;
  s.input.screenCursorPosition = () => {
    cursorReads++;
    return [s.input.pointerScreenX, s.input.pointerScreenY];
  };
  s.messages.mainTarget = () => {
    targetReads++;
    return mainTarget();
  };
  s.waits.dispatch = (message, wParam, lParam) => {
    s.order.push(`broadcast:${message.toString(16)}`);
    dispatch(message, wParam, lParam);
  };
  s.input.recordClickPosition = (slot, x, y) => {
    s.order.push(`handler:${slot}`);
    return saveClick(slot, x, y);
  };

  for (const button of [1, 6]) {
    push32(s.thread, button);
    assert.equal(s.definition.execute(s.context), 0);
    assert.equal(pop32(s.thread), 1);
    assert.equal(s.thread.stackIndex, 0);
  }

  assert.deepEqual(
    queries,
    [0x11, 0x01, 0x04, 0x02, 0x10, 0x05, 0x06, 0x11, 0x01, 0x04, 0x02, 0x10, 0x05, 0x06],
  );
  assert.equal(cursorReads, 2);
  assert.equal(targetReads, 4);
  assert.equal(s.messages.pending, 0);
  assert.deepEqual(s.order, [
    'broadcast:201',
    'handler:0',
    'focus',
    'broadcast:202',
    'broadcast:20b',
    'handler:4',
    'focus',
    'broadcast:20c',
  ]);
  const packedScreenPoint = 0xfffe2345n;
  for (const [message, wParam] of [
    [0x201, 0x0d],
    [0x202, 0x0c],
    [0x20b, 0x2004c],
    [0x20c, 0x2000c],
  ]) {
    const event = s.waits.consume(waiter, message);
    assert.equal(event?.received, true);
    assert.equal(event?.value1, BigInt(wParam));
    assert.equal(event?.value2, packedScreenPoint);
  }
  assert.deepEqual(s.input.clickPosition(0), [0x2345, 0xfffe]);
  assert.deepEqual(s.input.clickPosition(4), [0x2345, 0xfffe]);
  assert.equal(s.input.inputEventCount, 2);
  assert.equal(s.input.totalPresses(1), 1);
  assert.equal(s.input.totalPresses(6), 1);
  assert.deepEqual(s.notifications.take(), {type: 3, value1: 1, value2: 0});
  assert.deepEqual(s.notifications.take(), {type: 3, value1: 6, value2: 0});
  assert.equal(s.notifications.take(), null);
});
