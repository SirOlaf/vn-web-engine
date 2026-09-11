import test from 'node:test';
import assert from 'node:assert/strict';
import {NoahState} from '../dist/engines/mages/games/chaos-head-noah/sc3/noah-state.js';
import {NoahInput} from '../dist/engines/mages/games/chaos-head-noah/sc3/input.js';
import {MessageBoxes} from '../dist/engines/mages/games/chaos-head-noah/sc3/message-boxes.js';
import {
  drawDialog,
  drawDialogText,
} from '../dist/engines/mages/games/chaos-head-noah/sc3/dialog-draw.js';
const frame = (extras = {}) => ({
  keys: new Set(),
  pressed: new Set(),
  buttons: 0,
  pressedButtons: 0,
  x: 0,
  y: 0,
  wheel: 0,
  inside: false,
  ...extras,
});
function fixture(channel = 0) {
  const state = new NoahState(() => 0);
  state.initialize();
  state.put(0x17add76, 1, 1);
  const input = new NoahInput(state),
    sounds = [];
  const boxes = new MessageBoxes(state, {
    byte: () => 255,
    expression: () => {
      throw Error('unused');
    },
    hit: (...args) => input.hit(...args),
    sound: (id) => sounds.push(id),
  });
  boxes.clear(channel, 0);
  state.put(0x1de15a4 + channel * 0xb8, 2);
  boxes.open(channel, 255, 0);
  return {state, input, boxes, sounds};
}
test('native generated button regions feed the actual mouse confirmation and result path', () => {
  for (const channel of [0, 1])
    for (const choice of [0, 1]) {
      const {state, input, boxes, sounds} = fixture(channel),
        draw = drawDialog(boxes, channel, 32),
        hit = draw.regions[choice];
      input.setRegions(draw.regions);
      const point = {inside: true, x: hit.x + 1, y: hit.y + 1};
      for (let click = 0; click < 2; click++) {
        input.update(frame({...point, buttons: 1, pressedButtons: 1}));
        input.update(frame(point));
      }
      assert.equal(boxes.interact(channel), true);
      assert.equal(state.variable(0x850 + channel), choice);
      assert.deepEqual(sounds, [1, 2]);
    }
});
test('keyboard selection and cancellation stay in the dialog until confirmation', () => {
  const {state, input, boxes} = fixture();
  input.update(frame({keys: new Set(['ArrowRight']), pressed: new Set(['ArrowRight'])}));
  assert.equal(boxes.interact(0), false);
  assert.equal(state.get(0x1de15a8), 1);
  input.update(frame({pressed: new Set(['Escape']), keys: new Set(['Escape'])}));
  assert.equal(boxes.interact(0), false);
  assert.equal(state.variable(0x850), 255);
  input.update(frame({pressed: new Set(['Enter']), keys: new Set(['Enter'])}));
  assert.equal(boxes.interact(0), true);
  assert.equal(state.variable(0x850), 1);
});
test('fade reveals strips before text; redraw and scrub do not change animation randomness', () => {
  const {state, boxes} = fixture(),
    before = state.bytes(0x5a97e0, 88).slice();
  assert.equal(drawDialog(boxes, 0, 0).sprites.length, 0);
  assert.equal(drawDialog(boxes, 0, 15).regions.length, 0);
  assert.equal(drawDialog(boxes, 0, 16).sprites.at(-1).alpha, 0);
  assert.equal(drawDialog(boxes, 0, 32).sprites.at(-1).alpha, 256);
  assert.deepEqual(state.bytes(0x5a97e0, 88), before);
});
test('dialog text has native bounds, width reset and three separate expression evaluations', () => {
  const {state, boxes} = fixture();
  let evaluations = 0;
  const bytes = [128, 1, 0, 129, 0, 4, 7, 255];
  boxes.host.byte = (a) => bytes[a];
  boxes.host.expression = (a) => {
    evaluations++;
    return {value: 7, next: a + 1};
  };
  state.put(0x1de15a0, 1);
  state.put(0x1de15b0, 0, 8);
  drawDialog(boxes, 0, 32);
  assert.equal(evaluations, 3);
  boxes.host.byte = () => 128;
  assert.equal(drawDialogText(boxes, 0, 0, 0, 1, 0xffffff, 24, 256).length, 256);
  boxes.host.byte = () => 1;
  assert.throws(() => drawDialogText(boxes, 0, 0, 0, 0, 0, 24, 256), /cannot advance/);
});
