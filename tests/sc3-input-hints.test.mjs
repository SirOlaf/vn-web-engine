import test from 'node:test';
import assert from 'node:assert/strict';
import {NoahState} from '../dist/engines/mages/games/chaos-head-noah/sc3/noah-state.js';
import {NoahInput} from '../dist/engines/mages/games/chaos-head-noah/sc3/input.js';

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
  const s = new NoahState(() => 0);
  s.initialize();
  return {s, input: new NoahInput(s)};
}

test('native keyboard hint initializer survives VM initialization and input construction', () => {
  const {s, input} = fixture();
  assert.equal(s.get(0x20d22c), 1);
  input.update(frame());
  assert.equal(s.get(0x20d22c), 1);
  s.put(0x20d22c, 0);
  s.initialize();
  new NoahInput(s);
  assert.equal(
    s.get(0x20d22c),
    0,
    'VM initialization does not replay executable data initialization',
  );
});

test('held keys select keyboard hints without a binding or a new edge', () => {
  const {s, input} = fixture();
  s.zero(0x872140, 0xc80);
  s.put(0x20d22c, 0);
  input.update(frame({keys: new Set(['KeyQ'])}));
  assert.equal(s.get(0x20d22c), 1);
  assert.equal(s.get(0x5a70d0), 0);
  input.update(frame());
  assert.equal(s.get(0x20d22c), 1);
  s.put(0x20d22c, 0);
  input.update(frame({pressed: new Set(['KeyQ'])}));
  assert.equal(
    s.get(0x20d22c),
    0,
    'an edge without a held key does not set the native activity byte',
  );
});

test('mouse activity preserves hints; keyboard wins simultaneous 64-bit pad activity', () => {
  const {s, input} = fixture();
  s.put(0x20d22c, 0);
  for (const extra of [
    {x: 100},
    {buttons: 1},
    {buttons: 0},
    {wheel: 120},
    {inside: false},
    {focused: false},
  ]) {
    input.update(frame(extra));
    assert.equal(s.get(0x20d22c), 0);
  }
  for (const pad of [1n, 0x80000000n, 0x100000000n, 0x8000000000000000n]) {
    s.put(0x20d22c, 1);
    s.view(0x1dd9ca0, 8).setBigUint64(0, pad, true);
    input.update(frame());
    assert.equal(s.get(0x20d22c), 0);
    input.update(frame({keys: new Set(['KeyQ'])}));
    assert.equal(s.get(0x20d22c), 1);
    s.put(0x1dd9ca0, 0, 8);
    input.update(frame());
    assert.equal(s.get(0x20d22c), 1);
  }
});
