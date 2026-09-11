import test from 'node:test';
import assert from 'node:assert/strict';
import {NoahState} from '../dist/engines/mages/games/chaos-head-noah/sc3/noah-state.js';
import {NoahInput} from '../dist/engines/mages/games/chaos-head-noah/sc3/input.js';
const frame = (keys = [], pressed = []) => ({
  keys: new Set(keys),
  pressed: new Set(pressed),
  buttons: 0,
  pressedButtons: 0,
  x: 0,
  y: 0,
  wheel: 0,
  inside: false,
});
test('supplemental query consumes all row bindings but preserves low keyboard bits', () => {
  const s = new NoahState(() => 0),
    input = new NoahInput(s);
  s.initialize();
  s.put(0x872140 + 0x39 * 32, 30);
  s.put(0x872144 + 0x39 * 32, 31);
  s.put(0x1bae6e0 + 30, 0x85, 1);
  s.put(0x1bae6e0 + 31, 7, 1);
  assert.equal(input.query(0x1f), 1);
  assert.equal(input.query(0x1f), 0);
  assert.deepEqual([...s.bytes(0x1bae6e0 + 30, 2)], [5, 7]);
  s.put(0x543836, 1, 1);
  s.put(0x1bae6e0 + 30, 128, 1);
  assert.equal(input.query(0x1f), 0);
  assert.equal(s.bytes(0x1bae6e0 + 30, 1)[0], 128);
});
test('raw delayed-held keyboard begins on frame nine and clears on release', () => {
  const s = new NoahState(() => 0),
    input = new NoahInput(s);
  s.initialize();
  s.put(0x872ddc, 0);
  s.zero(0x872780, 32);
  s.put(0x872780, 29);
  for (let i = 0; i < 8; i++) {
    input.update(frame(['ControlLeft'], i === 0 ? ['ControlLeft'] : []));
    assert.equal(input.query(0x16), 0);
  }
  input.update(frame(['ControlLeft']));
  assert.equal(input.query(0x16), 1);
  assert.equal(s.get(0x1bae8e0 + 29 * 4), 9);
  input.update(frame());
  assert.equal(input.query(0x16), 0);
  assert.equal(s.get(0x1baece0 + 29 * 4), 0);
});
