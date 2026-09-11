import test from 'node:test';
import assert from 'node:assert/strict';
import {NoahState} from '../dist/engines/mages/games/chaos-head-noah/sc3/noah-state.js';
import {NoahInput} from '../dist/engines/mages/games/chaos-head-noah/sc3/input.js';
import {titleMenu} from '../dist/engines/mages/games/chaos-head-noah/sc3/opcodes/title-menu.js';

test('title menu consumes browser keyboard/pointer input and emits native UI sounds', () => {
  const state = new NoahState(() => 0);
  state.initialize();
  state.initializeTitle();
  const input = new NoahInput(state),
    sounds = [];
  const run = () =>
    titleMenu({state, input, skip: () => {}, byte: () => 1, sound: (...args) => sounds.push(args)});
  const key = (code) =>
    input.update({
      keys: new Set(code ? [code] : []),
      pressed: new Set(code ? [code] : []),
      buttons: 0,
      pressedButtons: 0,
      x: 960,
      y: 540,
      wheel: 0,
      inside: true,
    });
  state.setVariable(0x210c / 4, 1);
  state.setVariable(0x2110 / 4, 99);
  key('Enter');
  run();
  assert.equal(state.variable(0x210c / 4), 2);
  assert.equal(state.variable(0x2110 / 4), 0);
  state.setVariable(0x210c / 4, 3);
  state.put(0x17ac2e8, 99);
  state.put(0x5afa9c, 1);
  key();
  key('ArrowUp');
  run();
  assert.equal(state.get(0x5afa9c), 4);
  assert.deepEqual(sounds, [[1, 69]]);
  key();
  key('Enter');
  run();
  assert.equal(state.variable(0x210c / 4), 10);
  assert.deepEqual(sounds.at(-1), [2, 69]);
  key();
  for (let i = 0; i < 32; i++) run();
  assert.equal(state.variable(0x210c / 4), 11);
  state.put(0x17add76, 1, 1);
  input.setRegions([{group: 12, index: 2, x: 900, y: 500, width: 200, height: 100}]);
  const click = (button, x) => {
    const f = {
      keys: new Set(),
      pressed: new Set(),
      buttons: button,
      pressedButtons: button,
      x,
      y: 540,
      wheel: 0,
      inside: true,
    };
    input.update(f);
    input.update({...f, buttons: 0, pressedButtons: 0});
  };
  click(1, 961); // First release restores mouse mode and is consumed.
  click(1, 961);
  run();
  assert.equal(state.get(0x5b0990), 2);
  assert.equal(state.variable(0x216c / 4), 23);
  assert.deepEqual(sounds.at(-1), [2, 69]);
  click(2, 960);
  run();
  assert.equal(state.variable(0x210c / 4), 12);
  assert.deepEqual(sounds.at(-1), [3, 69]);
  key();
  for (let i = 0; i < 32; i++) run();
  assert.equal(state.variable(0x210c / 4), 3);
});

test('title confirmation delay runs for 64 ticks and preserves the selected native destination', () => {
  const state = new NoahState(() => 0);
  state.initialize();
  state.initializeTitle();
  state.setVariable(0x210c / 4, 3);
  state.put(0x5afa9c, 0);
  state.put(0x5a70d4, state.get(0x872dd4));
  const h = {state, input: {hit: () => false}, skip: () => {}, byte: () => 1, sound: () => {}};
  titleMenu(h);
  assert.equal(state.get(0x5b0a50), 1);
  state.put(0x5a70d4, 0);
  state.flags[0x9b] &= ~2;
  for (let i = 0; i < 62; i++) titleMenu(h);
  assert.equal(state.flags[0x9b] & 2, 0);
  titleMenu(h);
  assert.equal(state.get(0x5b0a50), 0);
  assert.equal(state.flags[0x9b] & 2, 2);
  assert.equal(state.variable(0x216c / 4), 50);
});

test('keyboard navigation owns selection until a short activation click release', () => {
  const state = new NoahState(() => 0);
  state.initialize();
  const input = new NoahInput(state);
  const frame = {
    keys: new Set(),
    pressed: new Set(),
    buttons: 0,
    pressedButtons: 0,
    x: 620,
    y: 188,
    wheel: 0,
    inside: true,
  };
  input.setRegions([{group: 10, index: 1, x: 608, y: 184, width: 112, height: 24}]);
  const click = () => {
    input.update({...frame, buttons: 1, pressedButtons: 1});
    input.update(frame);
  };
  input.update(frame);
  assert.equal(input.hit(10, 1, false), false);
  click();
  input.update(frame);
  assert.equal(input.hit(10, 1, false), true);
  input.update({...frame, keys: new Set(['ArrowDown']), pressed: new Set(['ArrowDown'])});
  assert.equal(input.hit(10, 1, false), false);
  input.update({...frame, x: 621});
  assert.equal(input.hit(10, 1, false), false);
  click();
  assert.equal(state.get(0x17add90), 0);
  assert.equal(input.hit(10, 1, false), true);
  click();
  assert.equal(state.get(0x17add90), 1);
  input.update({...frame, inside: false});
  assert.equal(input.hit(10, 1, false), false);
  assert.equal(state.bytes(0x17add76, 1)[0], 0);
});
