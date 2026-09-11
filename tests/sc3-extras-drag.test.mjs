import test from 'node:test';
import assert from 'node:assert/strict';
import {NoahState} from '../dist/engines/mages/games/chaos-head-noah/sc3/noah-state.js';
import {NoahInput} from '../dist/engines/mages/games/chaos-head-noah/sc3/input.js';

test('native pointer drag exposes anchor-relative and incremental movement separately', () => {
  const s = new NoahState(() => 0);
  s.initialize();
  const input = new NoahInput(s);
  const frame = (x, y, buttons, pressedButtons = 0, inside = true) => ({
    keys: new Set(),
    pressed: new Set(),
    x,
    y,
    buttons,
    pressedButtons,
    inside,
    wheel: 0,
  });
  input.update(frame(100, 200, 1, 1));
  input.update(frame(100, 200, 0)); // Activate mouse mode.
  input.update(frame(100, 200, 1, 1));
  assert.equal(s.get(0x17addf8), 0);
  assert.equal(s.get(0x17ade04), 0);
  assert.equal(s.get(0x17adda0) & 1, 1);
  assert.equal(s.get(0x17adda8) & 1, 0);
  input.update(frame(115, 230, 1));
  assert.equal(s.get(0x17addf4), 15);
  assert.equal(s.get(0x17addf8), 30);
  assert.equal(s.get(0x17ade00), 15);
  assert.equal(s.get(0x17ade04), 30);
  input.update(frame(112, 235, 1));
  assert.equal(s.get(0x17addf4), 12);
  assert.equal(s.get(0x17addf8), 35);
  assert.equal(s.get(0x17ade00), -3);
  assert.equal(s.get(0x17ade04), 5);
  input.update(frame(112, 235, 0));
  assert.equal(s.get(0x17addf8), 0);
  assert.equal(s.get(0x17adda8) & 1, 1);
  assert.equal(s.get(0x17add98) & 1, 0);
  input.update(frame(112, 235, 0, 0, false));
  assert.equal(s.get(0x17ade00), 0);
  assert.equal(s.get(0x17ade04), 0);
});
