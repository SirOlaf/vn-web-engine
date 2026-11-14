import test from 'node:test';
import assert from 'node:assert/strict';
import {ArtemisInput} from '../dist/engines/artemis/input.js';
import {ArtemisKeyBindings} from '../dist/engines/artemis/key-bindings.js';
import {ArtemisLua} from '../dist/engines/artemis/lua.js';
import {ArtemisVariables} from '../dist/engines/artemis/variables.js';
import {VirtualKeyState} from '../dist/input/virtual-keys.js';
import {directInputJoystickState, readBrowserJoystick} from '../dist/input/directinput-joystick.js';
import {luaText} from '../dist/core/lua51/runtime.js';
import {ARTEMIS_3179_EXECUTABLE_SHA256} from '../dist/engines/artemis/revision.js';
import {ArtemisTextFocus} from '../dist/engines/artemis/browser/text-focus.js';

const kinds = ['push', 'down', 'downEdge', 'upEdge', 'decide'];
const answers = (input, key) => kinds.filter((kind) => input.query(kind, key));
const sample = (down, extra = {}) => ({down: new Set(down), pointerInside: true, ...extra});

test('Artemis key states follow press, hold, repeat and release across updates', () => {
  const input = new ArtemisInput();
  input.update(1000, sample([13]));
  assert.deepEqual(answers(input, 13), ['push', 'down', 'downEdge', 'decide']);
  input.update(1100, sample([13]));
  assert.deepEqual(answers(input, 13), ['down']);
  // Past the 500 ms repeat delay every held update is a push again.
  input.update(1501, sample([13]));
  assert.deepEqual(answers(input, 13), ['push', 'down']);
  input.update(1520, sample([]));
  assert.deepEqual(answers(input, 13), ['upEdge']);
  input.update(1540, sample([]));
  assert.deepEqual(answers(input, 13), []);
  // A key released and pressed again starts a new press.
  input.update(1560, sample([13]));
  assert.deepEqual(answers(input, 13), ['push', 'down', 'downEdge', 'decide']);
  assert.throws(() => input.query('down', 0x140), /Unsupported Artemis input key/);
});

test('Mouse buttons need the pointer inside; key 1 falls back to the tap key', () => {
  const input = new ArtemisInput();
  input.update(0, sample([1, 2], {pointerInside: false}));
  assert.deepEqual(answers(input, 1), []);
  assert.deepEqual(answers(input, 2), []);
  input.update(10, sample([0x8a], {pointerInside: false}));
  assert.deepEqual(answers(input, 1), ['push', 'down', 'downEdge', 'decide']);
  assert.deepEqual(answers(input, 2), []);
});

test('Wheel notches persist until a push, down or down-edge query sees them', () => {
  const input = new ArtemisInput();
  input.update(0, sample([], {wheel: [137]}));
  // An up-edge query does not consume the notch.
  assert.equal(input.query('upEdge', 137), false);
  assert.equal(input.query('down', 137), true);
  assert.equal(input.query('push', 137), false);
  input.update(10, sample([]));
  assert.equal(input.query('down', 137), false);
  input.update(20, sample([], {wheel: [136]}));
  // Sampled key state never changes a wheel key.
  input.update(30, sample([136]));
  assert.equal(input.query('decide', 136), true);
  assert.equal(input.query('decide', 136), false);
});

const pad = (pressed, extra = {}) => ({
  id: 'pad',
  connected: true,
  mapping: 'standard',
  axes: [0, 0, 0, 0],
  buttons: Array.from({length: 18}, (_, i) => ({
    pressed: pressed.includes(i),
    value: +pressed.includes(i),
  })),
  ...extra,
});
const joystick = (axes = [], povs = [], buttons = []) => ({
  axes: Object.assign(new Array(8).fill(0), axes),
  povs: Object.assign(new Array(4).fill(0xffffffff), povs),
  buttons: Object.assign(new Array(32).fill(0), buttons),
});
const held = (input) => {
  const keys = [];
  for (let key = 0x100; key < 0x140; key++) if (input.query('down', key)) keys.push(key);
  return keys;
};

test('Joystick keys 256-319 follow DIJOYSTATE buttons, axes past 499 and POV sectors', () => {
  const input = new ArtemisInput();
  const at = (state) => {
    input.update(0, sample([], {joystick: state}));
    return held(input);
  };
  assert.deepEqual(
    at(joystick([], [], [0x80, 0, 0x80, ...new Array(28).fill(0), 0x80])),
    [256, 258, 287],
  );
  assert.deepEqual(at(joystick([-500, -499])), [288]);
  assert.deepEqual(
    at(joystick([500, 1000, -1000, 1000, 600, -700, -999, 999])),
    [290, 291, 292, 296, 297, 298, 300, 303],
  );
  assert.deepEqual(at(joystick([0, 0, 0, -500, 0, 500])), [294, 299]);
  // POV n uses keys 304+4n: left, up, right, down.
  const pov = (value, n = 0) => at(joystick([], Object.assign([], {[n]: value})));
  assert.deepEqual(pov(0), [305]);
  assert.deepEqual(pov(4499), [305]);
  assert.deepEqual(pov(4500), [306]);
  assert.deepEqual(pov(13499), [306]);
  assert.deepEqual(pov(13500), [307]);
  assert.deepEqual(pov(22500), [304]);
  assert.deepEqual(pov(31499), [304]);
  assert.deepEqual(pov(31500), [305]);
  assert.deepEqual(pov(9000, 3), [318]);
  assert.deepEqual(pov(0xffff), []);
  // Joystick keys repeat like keyboard keys and release when the device goes away.
  input.update(1000, sample([], {joystick: joystick([], [], [0, 0x80])}));
  assert.deepEqual(answers(input, 257), ['push', 'down', 'downEdge', 'decide']);
  input.update(1501, sample([], {joystick: joystick([], [], [0, 0x80])}));
  assert.deepEqual(answers(input, 257), ['push', 'down']);
  input.update(1520, sample([]));
  assert.deepEqual(answers(input, 257), ['upEdge']);
});

test('Browser gamepads report their DirectInput driver layout, the d-pad as POV 0', () => {
  const xinput = directInputJoystickState(
    pad([0, 2, 8, 13, 15], {axes: [-1, 0.5, 0.25, -0.75]}),
    1000,
  );
  assert.deepEqual(xinput.buttons.slice(0, 8), [0x80, 0, 0x80, 0, 0, 0, 0x80, 0]);
  assert.deepEqual(xinput.povs, [13500, 0xffffffff, 0xffffffff, 0xffffffff]);
  // Left trigger fully held: Z positive.
  assert.deepEqual(xinput.axes, [-1000, 500, 0, 250, -750, 0, 0, 0]);
  const lt = pad([]);
  lt.buttons[6] = {pressed: true, value: 1};
  assert.equal(directInputJoystickState(lt, 1000).axes[2], 1000);
  const sony = directInputJoystickState(
    pad([0, 2, 16, 12, 14], {
      id: 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)',
      axes: [0, 0, 0.5, -0.5],
    }),
    1000,
  );
  assert.deepEqual(sony.buttons.slice(0, 14), [0x80, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x80, 0]);
  assert.deepEqual(sony.axes, [0, 0, 500, -1000, -1000, -500, 0, 0]);
  assert.equal(sony.povs[0], 31500);
  // Opposite d-pad directions center the POV; other mappings pass through.
  assert.equal(directInputJoystickState(pad([12, 13]), 1000).povs[0], 0xffffffff);
  const raw = directInputJoystickState(
    pad([1, 17], {mapping: '', axes: [0.1, 0, 0, 0, 0, 0, 0, 0, 1]}),
    1000,
  );
  assert.deepEqual(
    [raw.buttons[1], raw.buttons[17], raw.povs[0], raw.axes[0], raw.axes.length],
    [0x80, 0x80, 0xffffffff, 100, 8],
  );
  // The first connected pad is the device; none, or a refused provider, is no device.
  assert.equal(
    readBrowserJoystick(
      {getGamepads: () => [null, {...pad([3]), connected: false}, pad([1])]},
      1000,
    ).buttons[1],
    0x80,
  );
  assert.equal(readBrowserJoystick({getGamepads: () => [null]}, 1000), null);
  assert.equal(
    readBrowserJoystick(
      {
        getGamepads: () => {
          throw Error('denied');
        },
      },
      1000,
    ),
    null,
  );
  assert.equal(readBrowserJoystick(undefined, 1000), null);
});

test('Keys are false while the window is not foreground; overrides still answer', () => {
  const input = new ArtemisInput();
  input.update(0, sample([13, 1], {foreground: false, wheel: [136]}));
  assert.deepEqual(answers(input, 13), []);
  assert.deepEqual(answers(input, 1), []);
  assert.deepEqual(answers(input, 136), []);
  input.override(13, 2);
  assert.deepEqual(answers(input, 13), ['push']);
  // A notch not seen in the background is still there in the foreground.
  input.update(10, sample([13], {foreground: true}));
  assert.deepEqual(answers(input, 136), ['push']);
  assert.deepEqual(answers(input, 13), ['down']);
});

test('overrideKey answers with status bits for one update and refuses keys from 0x140', () => {
  const input = new ArtemisInput();
  input.update(0, sample([]));
  assert.equal(input.override(1, 0x3e), true);
  assert.deepEqual(answers(input, 1), kinds);
  // status & 0x3e | 1: bit 2 alone answers down.
  assert.equal(input.override(undefined, 4), true);
  assert.deepEqual(answers(input, 1), ['down']);
  assert.deepEqual(answers(input, 0x13f), ['down']);
  // A cleared override (status -1) falls back to the sampled state; key 1 still answers
  // through the tap key's override.
  assert.equal(input.override(1, -1), true);
  assert.deepEqual(answers(input, 1), ['down']);
  assert.equal(input.override(undefined, -1), true);
  assert.deepEqual(answers(input, 1), []);
  assert.equal(input.override(0x140, 4), false);
  input.override(5, 0x20);
  assert.deepEqual(answers(input, 5), ['decide']);
  input.update(10, sample([]));
  assert.deepEqual(answers(input, 5), []);
});

test('Virtual keys report a press released between two samples once', () => {
  const keys = new VirtualKeyState();
  keys.press(1);
  keys.release(1);
  assert.deepEqual([...keys.sample()], [1]);
  assert.deepEqual([...keys.sample()], []);
  keys.press(13);
  assert.deepEqual([...keys.sample()], [13]);
  assert.deepEqual([...keys.sample()], [13]);
  keys.releaseAll();
  assert.deepEqual([...keys.sample()], []);
});

test('var system=unixtime and system=date read the host clock as 32-bit local time', () => {
  let now = 1_700_000_000_999;
  const variables = new ArtemisVariables({
    stageSize: () => ({width: 1, height: 1}),
    now: () => now,
  });
  const tag = (args) => ({kind: 'tag', name: 'var', sourceLine: -1, args: new Map(args)});
  const fields = (name) =>
    ['year', 'month', 'day', 'hour', 'minute', 'second'].map((field) =>
      luaText(variables.read(`${name}.${field}`)),
    );
  const local = (seconds) => {
    const date = new Date(seconds * 1000);
    return [
      date.getFullYear(),
      date.getMonth() + 1,
      date.getDate(),
      date.getHours(),
      date.getMinutes(),
      date.getSeconds(),
    ].map(String);
  };
  variables.dispatch(
    tag([
      ['name', 't.now'],
      ['system', 'unixtime'],
    ]),
  );
  assert.equal(luaText(variables.read('t.now')), '1700000000');
  variables.dispatch(
    tag([
      ['name', 't.d'],
      ['system', 'date'],
    ]),
  );
  assert.deepEqual(fields('t.d'), local(1_700_000_000));
  // The unixtime argument is read with atoi and reinterpreted as unsigned.
  variables.dispatch(
    tag([
      ['name', 't.e'],
      ['system', 'date'],
      ['unixtime', ' -1x'],
    ]),
  );
  assert.deepEqual(fields('t.e'), local(0xffffffff));
  // _time64 is stored through the 32-bit integer setter.
  now = 0x80000000 * 1000;
  variables.dispatch(
    tag([
      ['name', 't.now'],
      ['system', 'unixtime'],
    ]),
  );
  assert.equal(luaText(variables.read('t.now')), '-2147483648');
  variables.pushLocal();
  variables.dispatch(
    tag([
      ['name', 't.l'],
      ['system', 'date'],
      ['writelocal', '1'],
    ]),
  );
  assert.deepEqual(fields('t.l'), local(0x80000000));
  variables.popLocal();
  assert.equal(variables.lookup('t.l.year'), undefined);
});

test('Lua input, script status, frame and touch bindings check argument types natively', () => {
  const input = new ArtemisInput();
  input.update(0, sample([13]));
  const reports = [],
    statuses = [],
    holds = [];
  let status = 1;
  const lua = new ArtemisLua({
    readFile: () => null,
    fileExists: () => false,
    now: () => 0,
    variable: () => '',
    tag: () => {},
    enqueueTag: () => {},
    reportError: (message) => reports.push(Buffer.from(message)),
    input,
    scriptStatus: () => status,
    setScriptStatus: (mode) => statuses.push(mode),
    frameNumber: () => 0x80000005,
    touch: {count: () => 2, setHold: (enabled) => holds.push(enabled)},
  });
  // `<name>の引数が不正です` in code page 932.
  const argumentError = (name) =>
    Buffer.concat([Buffer.from(name), Buffer.from('82cc88f8909482aa957390b382c582b7', 'hex')]);
  try {
    lua.vm.execute(
      new TextEncoder().encode(`p = engine:isPush(13); d = engine:isDecide(13.9)
        u = engine:isUpEdge(13); bad = engine:isDown('13')
        engine:overrideKey{key=13, status=16}; o = engine:isUpEdge(13)
        engine:overrideKey(13)
        engine:overrideKey{key=0x140, status=4}
        s = engine:getScriptStatus(); engine:setScriptStatus(4.7); engine:setScriptStatus('0')
        f = engine:getFrameNumber(); t = engine:getTouchCount()
        engine:setUseTouchHold(true); engine:setUseTouchHold(1)`),
      'input',
    );
    assert.deepEqual(
      ['p', 'd', 'u', 'bad', 'o', 's', 'f', 't'].map((name) => lua.vm.getGlobal(name)),
      [true, true, false, null, true, 1, 5, 2],
    );
    assert.deepEqual(statuses, [4]);
    assert.deepEqual(holds, [true]);
    assert.deepEqual(reports, [
      argumentError('isDown'),
      argumentError('overrideKey'),
      argumentError('overrideKey'),
      argumentError('setScriptStatus'),
      argumentError('setUseTouchHold'),
    ]);
  } finally {
    lua.close();
  }
});

test('Roles answer through their keys; Alt+Enter does not decide an Enter role', () => {
  const bindings = new ArtemisKeyBindings();
  const keyconfig = (role, keys) =>
    bindings.dispatch({
      kind: 'tag',
      name: 'keyconfig',
      sourceLine: -1,
      args: new Map([
        ['role', String(role)],
        ['keys', keys],
      ]),
    });
  keyconfig(0, '1,13,137');
  keyconfig(1, '2');
  const input = new ArtemisInput();
  const role = (id, kind) => bindings.roleActive(id, kind, (k, key) => input.query(k, key));
  input.update(0, sample([1]));
  assert.deepEqual([role(0, 'decide'), role(0, 'down'), role(1, 'decide')], [true, true, false]);
  input.update(10, sample([1]));
  assert.deepEqual([role(0, 'decide'), role(0, 'down')], [false, true]);
  input.update(20, sample([], {wheel: [137]}));
  assert.equal(role(0, 'decide'), true);
  assert.equal(role(0, 'decide'), false);
  input.update(30, sample([13, 0x12]));
  assert.deepEqual([role(0, 'decide'), role(0, 'down')], [false, true]);
  input.update(40, sample([]));
  input.update(50, sample([13]));
  assert.equal(role(0, 'decide'), true);
  // Joystick keys take roles like any other key: button 3 is key 258, POV down 307.
  keyconfig(2, '13,258,307');
  input.update(60, sample([]));
  input.update(70, sample([], {joystick: joystick([], [], [0, 0, 0x80])}));
  assert.equal(role(2, 'decide'), true);
  input.update(80, sample([]));
  input.update(90, sample([], {joystick: joystick([], [18000])}));
  assert.deepEqual([role(2, 'decide'), role(1, 'down')], [true, false]);
});

test('var system=length stores source bytes, or UTF-8 characters for mode 1', () => {
  const variables = new ArtemisVariables({stageSize: () => ({width: 1, height: 1})});
  const length = (name, args, bytes) =>
    variables.dispatch({
      kind: 'tag',
      name: 'var',
      sourceLine: -1,
      args: new Map([
        ['name', name],
        ['system', 'length'],
        ...(bytes ? [['source', new TextDecoder().decode(bytes)]] : []),
        ...args,
      ]),
      // A tag's raw argument bytes accompany its decoded text.
      ...(bytes ? {bytes: new Map([['source', bytes]])} : {}),
    });
  const read = (name) => luaText(variables.read(name));
  length('t.b', [['source', 'Aあ\n']]);
  length('t.z', [
    ['source', 'Aあ\n'],
    ['mode', '0'],
  ]);
  length('t.c', [
    ['source', 'Aあ\n'],
    ['mode', '1'],
  ]);
  assert.deepEqual([read('t.b'), read('t.z'), read('t.c')], ['5', '5', '3']);
  // Mode 1 stops at NUL, counts a stray continuation byte once and skips by the lead byte.
  length('t.r', [['mode', '1']], Uint8Array.of(0x80, 0xe3, 0x81, 0x82, 0x41, 0, 0x41));
  assert.equal(read('t.r'), '3');
  // Any other mode leaves the variable alone.
  length('t.c', [
    ['source', 'x'],
    ['mode', '2'],
  ]);
  assert.equal(read('t.c'), '3');
  assert.throws(
    () => length('t.e', [['mode', '1']], Uint8Array.of(0x41, 0xe3, 0x81)),
    /ends inside a character/,
  );
});

test('var without data or a native system value writes nothing', () => {
  const variables = new ArtemisVariables({stageSize: () => ({width: 1, height: 1})});
  const tag = (args) =>
    variables.dispatch({kind: 'tag', name: 'var', sourceLine: -1, args: new Map(args)});
  tag([
    ['name', 't.rule'],
    ['data', 'x'],
  ]);
  // A Lua table field set to nil (`data=(rule)`) leaves only name and writelocal.
  assert.equal(
    tag([
      ['name', 't.rule'],
      ['writelocal', '1'],
    ]),
    true,
  );
  tag([
    ['name', 't.rule'],
    ['system', 'no_such_query'],
  ]);
  assert.equal(luaText(variables.read('t.rule')), 'x');
  // A native query this engine does not implement is still reported.
  assert.throws(
    () =>
      tag([
        ['name', 't.r'],
        ['system', 'random'],
      ]),
    /Unsupported native Artemis var system random/,
  );
});

test('var system=get_layer_info writes a CLayer actor in native key order', async () => {
  const {ArtemisDisplayObject} = await import('../dist/engines/artemis/display-object.js');
  const {artemisFloatText, artemisLayerExtent} =
    await import('../dist/engines/artemis/layer-info.js');
  const display = new ArtemisDisplayObject(ARTEMIS_3179_EXECUTABLE_SHA256);
  display.apply({left: -20.75, top: 3, alpha: 254 / 255, xscale: 0.5, visible: false});
  display.apply({
    draggable: true,
    dragarea: {left: 1, top: 2, width: 3, height: 3, right: 3, bottom: 4},
  });
  const clip = {left: 0.5, top: 0, width: 0, height: 0, right: 0, bottom: 0};
  const surface = {width: 1, height: 1};
  const queried = [];
  const variables = new ArtemisVariables({
    stageSize: () => ({width: 1, height: 1}),
    layerInfo: (id) => {
      queried.push(id);
      if (id !== '500.sample') return undefined;
      return {
        display,
        ...artemisLayerExtent(surface, clip),
        surface,
        clip,
        layerMode: 'screen',
        negative: true,
        grayscale: false,
        colorMultiply: 0xffffffff,
        shader: 'blur',
        shaderConstants: [{name: 'c', values: [Math.fround(0.1), 1e9]}],
      };
    },
  });
  const tag = (args) => ({kind: 'tag', name: 'var', sourceLine: -1, args: new Map(args)});
  variables.dispatch(
    tag([
      ['name', 't.ly'],
      ['system', 'get_layer_info'],
      ['id', '500.sample'],
      ['style', 'map'],
    ]),
  );
  const read = (key) => luaText(variables.read(`t.ly.${key}`));
  assert.deepEqual(
    [
      'left',
      'top',
      'width',
      'height',
      'alpha',
      'xscale',
      'yscale',
      'visible',
      'surfacewidth',
      'clip',
      'layermode',
      'negative',
      'colormultiply',
      'shader',
      'shaderconstant.size',
      'shaderconstant.0.name',
      'shaderconstant.0.data.size',
      'shaderconstant.0.data.0',
      'shaderconstant.0.data.1',
      'draggable',
      'dragarea',
    ].map(read),
    [
      '-20',
      '3',
      '1',
      '1',
      '254',
      '50',
      '100',
      '0',
      '1',
      '0.5,0,0,0',
      '4',
      '1',
      '-1',
      'blur',
      '1',
      'c',
      '2',
      '0.100000001',
      '1e+09',
      '1',
      '1,2,3,4',
    ],
  );
  // An unknown id writes nothing; the id-less enumeration is refused.
  variables.dispatch(
    tag([
      ['name', 't.no'],
      ['system', 'get_layer_info'],
      ['id', 'missing'],
    ]),
  );
  assert.equal(variables.lookup('t.no.left'), undefined);
  assert.deepEqual(queried, ['500.sample', 'missing']);
  assert.throws(
    () =>
      variables.dispatch(
        tag([
          ['name', 't.e'],
          ['system', 'get_layer_info'],
        ]),
      ),
    /layer enumeration/,
  );
  // MSVC %.9g: fixed notation for exponents -4..8, trimmed zeros, two exponent digits.
  assert.deepEqual([0.0001, 0.00001, 123456789, -0, 2.5, Infinity, NaN].map(artemisFloatText), [
    '0.0001',
    '1e-05',
    '123456789',
    '-0',
    '2.5',
    'inf',
    'nan',
  ]);
});

test('A focused DOM text slot that goes away gives focus back to the canvas', () => {
  const element = (fields = {}) => ({
    isConnected: true,
    tabIndex: 0,
    hidden: false,
    focused: 0,
    closest() {
      return this.hidden ? this : null;
    },
    focus() {
      this.focused++;
      document.activeElement = this;
    },
    ...fields,
  });
  const document = {activeElement: null, body: {}};
  const canvas = element(),
    focus = new ArtemisTextFocus(document, canvas);
  // A choice slot clicked, then hidden: focus is still on it or already on the body.
  for (const fixup of [false, true]) {
    const choice = element();
    choice.focus();
    focus.focusin(choice, true);
    assert.equal(focus.restore(), false);
    choice.hidden = true;
    if (fixup) document.activeElement = document.body;
    assert.equal(focus.restore(), true);
    assert.equal(document.activeElement, canvas);
  }
  // Made inert (tabIndex -1) or removed.
  for (const gone of [{tabIndex: -1}, {isConnected: false}]) {
    const slot = element();
    slot.focus();
    focus.focusin(slot, true);
    Object.assign(slot, gone);
    assert.equal(focus.restore(), true);
    assert.equal(document.activeElement, canvas);
  }
  // Focus moved to a page control, or the slot was left by a click outside the player and
  // stays visible: kept, also when the slot goes away later.
  const kept = element(),
    control = element();
  kept.focus();
  focus.focusin(kept, true);
  control.focus();
  kept.hidden = true;
  assert.equal(focus.restore(), false);
  assert.equal(document.activeElement, control);
  const left = element();
  left.focus();
  focus.focusin(left, true);
  document.activeElement = document.body;
  assert.equal(focus.restore(), false);
  left.hidden = true;
  assert.equal(focus.restore(), false);
  assert.equal(document.activeElement, document.body);
  // Focus on the canvas itself is not tracked.
  focus.focusin(canvas, false);
  assert.equal(focus.restore(), false);
  assert.equal(canvas.focused, 4);
});
