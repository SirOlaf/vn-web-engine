import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBrowserGamepads} from '../dist/engines/buriko/native/browser-gamepads.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoNativeGamepads} from '../dist/engines/buriko/native/gamepads.js';
import {createGroup81Gamepads} from '../dist/engines/buriko/native/group-81-gamepads.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BurikoNativeNotifications} from '../dist/engines/buriko/native/notification-queue.js';

const capabilities = Object.freeze({
  size: 44,
  flags: 0,
  deviceType: 20,
  axes: 4,
  buttons: 16,
  povs: 1,
  forceFeedbackSamplePeriod: 0,
  forceFeedbackMinimumTimeResolution: 0,
  firmwareRevision: 0,
  hardwareRevision: 0,
  forceFeedbackDriverVersion: 0,
});

const blankButtons = () =>
  Array.from({length: 16}, () => ({
    pressed: false,
    value: 0,
  }));

function pad(index, id) {
  return {
    index,
    id,
    connected: true,
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: blankButtons(),
  };
}

function profile(index, id, guid, buttonMap = undefined) {
  return {
    browserIndex: index,
    browserId: id,
    browserMapping: 'standard',
    instanceGuid: guid,
    capabilities,
    axes: [{index: 0}, {index: 1}, {index: 2}, null, null, {index: 3}, null, null],
    povs: [{up: 12, right: 15, down: 13, left: 14}, null, null, null],
    buttons: buttonMap ?? Array.from({length: 32}, (_, button) => (button < 16 ? button : null)),
  };
}

function fixture(pads, profiles) {
  const provider = {getGamepads: () => pads},
    host = new BurikoBrowserGamepads(provider, profiles),
    input = new BurikoNativeInput(
      new BurikoNativeDisplayState(1920, 1080),
      new BurikoNativeClock(() => 0),
    ),
    notifications = new BurikoNativeNotifications(),
    gamepads = new BurikoNativeGamepads(host, input, notifications);
  return {gamepads, input, notifications};
}

test('explicit browser profiles produce native IDs, merged state and exact POV/button words', () => {
  const first = pad(0, 'browser pad alpha'),
    second = pad(1, 'browser pad beta'),
    ignored = pad(2, 'unprofiled browser pad');
  first.axes.splice(0, 4, 0.75, -0.5, 0.25, -0.25);
  first.buttons[0].pressed = true;
  first.buttons[0].value = 1;
  first.buttons[12].pressed = true; // Up.
  second.axes.splice(0, 4, 0.75, -0.75, -0.5, 0.5);
  second.buttons[1].pressed = true;
  second.buttons[1].value = 1;
  second.buttons[15].pressed = true; // Right.
  const secondButtons = Array(32).fill(null);
  secondButtons[31] = 1;
  const {gamepads} = fixture(
    [first, second, ignored],
    [
      profile(0, first.id, '01234567-89ab-cdef-0123-456789abcdef'),
      profile(1, second.id, 'fedcba98-7654-3210-fedc-ba9876543210', secondButtons),
    ],
  );

  assert.equal(gamepads.initialize(), 1);
  assert.equal(gamepads.enabled, 1);
  assert.deepEqual(gamepads.deviceIds, [2, 1]);
  assert.equal(gamepads.deviceCounter, 2);
  assert.deepEqual(gamepads.capabilities(1), capabilities);
  assert.deepEqual(gamepads.query(1), {
    x: 768,
    y: -512,
    z: 256,
    rz: -256,
    pov: 0,
    buttons: 0x1001,
  });
  assert.deepEqual(gamepads.query(0), {
    x: 1024,
    y: -1024,
    z: -256,
    rz: 256,
    pov: 1,
    buttons: 0x80001001,
  });
  assert.equal(gamepads.query(99), null);
});

test('buffered browser changes use the shared notification queue and input mappings', () => {
  const current = pad(0, 'browser pad events'),
    {gamepads, input, notifications} = fixture(
      [current],
      [profile(0, current.id, '00112233-4455-6677-8899-aabbccddeeff')],
    );
  gamepads.setMapping(0, 13);
  gamepads.setMapping(32, 38);
  gamepads.setMapping(33, 40);
  gamepads.setMapping(34, 37);
  gamepads.setMapping(35, 39);
  assert.equal(gamepads.poll(), 1);
  assert.equal(gamepads.initialize(), 1);

  current.axes.splice(0, 4, 1, -1, 0.5, -0.5);
  for (const button of [0, 12, 15]) {
    current.buttons[button].pressed = true;
    current.buttons[button].value = 1;
  }
  assert.equal(gamepads.poll(), 0);
  assert.deepEqual(gamepads.cachedAxes, [1024, -1024, 512, -512]);
  assert.deepEqual(
    Array.from({length: 6}, () => notifications.take()),
    [
      {type: 0x102, value1: 1, value2: 1},
      {type: 0x100, value1: 0x80, value2: 1},
      {type: 0x100, value1: 0x8c, value2: 1},
      {type: 0x100, value1: 0x8f, value2: 1},
      {type: 0x101, value1: 0xc00400, value2: 1},
      {type: 0x101, value1: 0x1e00200, value2: 1},
    ],
  );
  assert.equal(notifications.take(), null);
  assert.equal(input.totalPresses(13), 1);
  assert.equal(input.totalPresses(38), 2);
  assert.equal(input.totalPresses(39), 1);
  assert.equal(gamepads.poll(), 0);
  assert.equal(notifications.take(), null);

  gamepads.shutdown();
  assert.equal(gamepads.enabled, 0);
  assert.deepEqual(gamepads.deviceIds, []);
  assert.equal(gamepads.mapping(0), 13);
  assert.deepEqual(gamepads.cachedAxes, [1024, -1024, 512, -512]);
  assert.equal(gamepads.initialize(), 1);
  assert.deepEqual(gamepads.deviceIds, [2]);
});

test('81 1B/1D preserve native pop order, success values and output write order', () => {
  const current = pad(3, 'browser pad vm');
  current.axes.splice(0, 4, -0.25, 0.5, 1, -1);
  current.buttons[2].pressed = true;
  current.buttons[2].value = 1;
  const {gamepads} = fixture(
    [current],
    [profile(3, current.id, '12345678-9abc-def0-1234-56789abcdef0')],
  );
  assert.equal(gamepads.initialize(), 1);
  const definitions = createGroup81Gamepads(gamepads),
    bytes = new Uint8Array(256).fill(0xa5),
    memory = new BurikoBpMemory(bytes),
    thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 32,
      moduleCapacity: 32,
      frameCapacity: 32,
    }),
    call = (secondary, ...args) => {
      for (const value of args) push32(thread, value);
      definitions.find((slot) => slot.secondary === secondary).execute({thread, memory});
      return pop32(thread);
    };

  assert.equal(call(0x1b, 7, 0x89abcdef), 1);
  assert.equal(gamepads.mapping(7), 0x89abcdef);
  assert.equal(call(0x1b, 36, 123), 0);
  assert.equal(call(0x1d, 32, 1), 1);
  const view = new DataView(bytes.buffer, 32, 24);
  assert.deepEqual(
    [
      view.getInt32(0, true),
      view.getInt32(4, true),
      view.getInt32(8, true),
      view.getInt32(12, true),
      view.getUint32(16, true),
      view.getUint32(20, true),
    ],
    [-256, 512, 1024, -1024, 0xffffffff, 4],
  );
  assert.equal(call(0x1d, 96, 99), 0);
  assert.deepEqual([...bytes.subarray(96, 120)], Array(24).fill(0xa5));
  assert.equal(thread.stackIndex, 0);
});
