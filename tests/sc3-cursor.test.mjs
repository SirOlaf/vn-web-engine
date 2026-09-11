import test from 'node:test';
import assert from 'node:assert/strict';
import {NoahState} from '../dist/engines/mages/games/chaos-head-noah/sc3/noah-state.js';
import {NoahInput} from '../dist/engines/mages/games/chaos-head-noah/sc3/input.js';
import {BrowserNoahCursor} from '../dist/engines/mages/games/chaos-head-noah/sc3/browser-cursor.js';
const frame = (extra = {}) => ({
  keys: new Set(),
  pressed: new Set(),
  buttons: 0,
  pressedButtons: 0,
  x: 20,
  y: 30,
  wheel: 0,
  inside: true,
  ...extra,
});
function fixture() {
  const state = new NoahState(() => 0);
  state.initialize();
  const input = new NoahInput(state);
  return {state, input};
}
function click(input, extra = {}) {
  input.update(frame({...extra, buttons: 1}));
  input.update(frame(extra));
}

test('cursor callbacks preserve the previous-hit latch and persistent drag byte', () => {
  const {state: s, input} = fixture(),
    events = [];
  input.cursor.onChange = (image) => events.push(image);
  input.setRegions([{group: 1, index: 0, x: 0, y: 0, width: 50, height: 50}]);
  click(input);
  input.update(frame());
  assert.equal(input.hit(1, 0, true), true);
  assert.equal(input.cursor.current, 'active');
  assert.equal(s.bytes(0x17add72, 1)[0], 1);
  events.length = 0;
  input.update(frame({x: 100}));
  assert.deepEqual(events, []);
  assert.equal(s.bytes(0x17add72, 1)[0], 0);
  assert.equal(input.hit(1, 0, true), false);
  input.update(frame({x: 100}));
  assert.deepEqual(events, ['normal']);
  s.put(0x17add73, 1, 1);
  input.update(frame({x: 100}));
  assert.equal(events.at(-1), 'active');
  assert.equal(s.bytes(0x17add73, 1)[0], 1);
  s.put(0x17add73, 0, 1);
  input.update(frame({x: 100}));
  assert.equal(events.at(-1), 'normal');
  s.put(0x17add76, 0, 1);
  s.put(0x17add72, 1, 1);
  events.length = 0;
  input.cursor.prepare();
  assert.deepEqual(events, []);
  assert.equal(s.bytes(0x17add72, 1)[0], 1);
});

test('only short releases activate mouse mode, and leaving the client does not disable it', () => {
  for (const duration of [1, 14, 15, 30]) {
    const {state: s, input} = fixture();
    input.update(frame());
    assert.equal(input.cursor.current, 'system');
    input.update(frame({x: 21}));
    assert.equal(s.bytes(0x17add76, 1)[0], 0);
    for (let n = 0; n < duration; n++) input.update(frame({buttons: 1}));
    input.update(frame());
    assert.equal(s.bytes(0x17add76, 1)[0], +(duration < 15));
    assert.equal(s.get(0x17add90), 0);
  }
  const {state: s, input} = fixture();
  click(input);
  input.update(frame());
  input.update(frame({inside: false}));
  assert.equal(s.bytes(0x17add76, 1)[0], 0);
  input.update(frame());
  assert.equal(s.bytes(0x17add76, 1)[0], 1);
  input.update(frame({focused: false}));
  assert.equal(input.cursor.current, 'system');
  input.update(frame());
  assert.equal(s.bytes(0x17add76, 1)[0], 0);
  click(input);
  input.update(frame());
  click(input);
  assert.equal(s.get(0x17add90), 1);
});

test('native hit queries use inclusive edges, duplicate union and explicit activation', () => {
  const {input, state: s} = fixture();
  input.setRegions([
    {group: 1, index: 0, x: 0, y: 0, width: 20, height: 30},
    {group: 1, index: 0, x: 0, y: 0, width: 50, height: 50, value: 0},
  ]);
  click(input);
  input.update(frame());
  assert.equal(input.hit(1, 0, false), true);
  assert.equal(input.cursor.current, 'normal');
  assert.equal(s.bytes(0x17add72, 1)[0], 0);
  assert.equal(input.hit(1, 0, true), true);
  assert.equal(input.cursor.current, 'active');
  assert.equal(input.hit(32, 0, true), false);
  assert.equal(input.hit(1, 65535, true), false);
  input.onActivate = undefined;
  s.put(0x17add72, 0, 1);
  assert.equal(input.hit(1, 0, true), true);
  assert.equal(s.bytes(0x17add72, 1)[0], 0);
});

test('cursor presentation restores styles, disconnects old runtimes and releases object URLs', (t) => {
  const revoke = t.mock.method(URL, 'revokeObjectURL');
  const element = {style: {cursor: 'crosshair'}},
    resources = {normal: new Uint8Array([1]), active: new Uint8Array([2])};
  const presenter = new BrowserNoahCursor(element, resources),
    a = fixture().input.cursor,
    b = fixture().input.cursor;
  presenter.bind(a);
  const normal = element.style.cursor;
  assert.match(normal, /^url\("blob:/);
  a.activate();
  const active = element.style.cursor;
  assert.notEqual(active, normal);
  a.useSystem();
  assert.equal(element.style.cursor, 'default');
  presenter.bind(b);
  a.activate();
  assert.equal(element.style.cursor, normal);
  presenter.clear();
  assert.equal(element.style.cursor, 'crosshair');
  assert.equal(b.onChange, undefined);
  presenter.bind(b);
  presenter.dispose();
  assert.equal(element.style.cursor, 'crosshair');
  assert.equal(b.onChange, undefined);
  presenter.dispose();
  assert.throws(() => presenter.bind(a), /disposed/);
  assert.equal(revoke.mock.callCount(), 2);
  assert.deepEqual(
    new Set(revoke.mock.calls.map((c) => c.arguments[0])),
    new Set([normal, active].map((css) => css.match(/url\("([^"]+)"\)/)[1])),
  );
});
