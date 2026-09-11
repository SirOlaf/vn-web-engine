import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TouchMouse} from '../dist/input/touch-mouse.js';
import {NoahInput} from '../dist/engines/mages/games/chaos-head-noah/sc3/input.js';
import {NoahState} from '../dist/engines/mages/games/chaos-head-noah/sc3/noah-state.js';
const at = (x = 100, y = 100, inside = true) => ({x, y, inside});
const drain = (touch, n = 5) => Array.from({length: n}, () => touch.sample());

test('short tap preserves down and release, even entirely between host ticks', () => {
  const touch = new TouchMouse(() => 0);
  touch.down(1, true, at());
  touch.up(1, at());
  const frames = drain(touch);
  assert.deepEqual(
    frames.map((f) => f.buttons),
    [0, 1, 0, 0, 0],
  );
  assert.deepEqual(
    frames.map((f) => f.pressedButtons),
    [0, 1, 0, 0, 0],
  );
  assert.ok(frames.every((f) => f.inside && f.x === 100));
});
test('stationary hold emits exactly one right click and never a left click', () => {
  let now = 0;
  const touch = new TouchMouse(() => now);
  touch.down(1, true, at());
  assert.equal(touch.sample().buttons, 0);
  now = 499;
  assert.equal(touch.sample().buttons, 0);
  now = 500;
  assert.deepEqual(
    drain(touch).map((f) => f.buttons),
    [2, 0, 0, 0, 0],
  );
  now = 5000;
  touch.up(1, at());
  assert.ok(drain(touch).every((f) => f.buttons === 0 && f.pressedButtons === 0));
});
test('long press is recognized on release when no samples occurred during the hold', () => {
  let now = 0;
  const touch = new TouchMouse(() => now);
  touch.down(1, true, at());
  now = 600;
  touch.up(1, at());
  assert.deepEqual(
    drain(touch).map((f) => f.buttons),
    [0, 2, 0, 0, 0],
  );
});
test('drag retains its anchor, coalesces movement, and cannot become a right click', () => {
  let now = 0;
  const touch = new TouchMouse(() => now);
  touch.down(1, true, at(), {x: 10, y: 10});
  touch.sample();
  touch.move(1, at(200), {x: 19, y: 10});
  touch.move(1, at(300), {x: 25, y: 10});
  assert.equal(touch.sample().x, 100);
  const move = touch.sample();
  assert.equal(move.x, 300);
  assert.equal(move.buttons, 1);
  now = 2000;
  assert.equal(touch.sample().buttons, 1);
  touch.up(1, at(300), {x: 25, y: 10});
  const frames = drain(touch);
  assert.ok(frames.every((f) => f.buttons !== 2));
  assert.equal(frames.at(-1).buttons, 0);
});
test('movement tolerance uses CSS pixels, independent of native canvas scaling', () => {
  let now = 0;
  const touch = new TouchMouse(() => now);
  touch.down(1, true, at(), {x: 10, y: 10});
  touch.sample();
  touch.move(1, at(130), {x: 15, y: 10});
  now = 500;
  assert.equal(touch.sample().buttons, 2);
});
test('secondary contacts do not move, release or cancel the primary pointer', () => {
  const touch = new TouchMouse(() => 0);
  assert.equal(touch.down(2, false, at()), false);
  touch.down(1, true, at());
  assert.equal(touch.down(2, true, at(500)), false);
  touch.move(2, at(500));
  touch.up(2, at(500));
  touch.cancel(2);
  assert.equal(touch.active, true);
  assert.equal(touch.sample().x, 100);
  touch.up(1, at());
  assert.equal(touch.sample().buttons, 1);
});
test('cancellation drops pending clicks and holds; normal capture loss preserves release', () => {
  const touch = new TouchMouse(() => 0);
  touch.down(1, true, at());
  touch.move(1, at(200));
  touch.cancel(1);
  assert.ok(drain(touch).every((f) => !f.buttons && !f.pressedButtons && !f.inside));
  touch.down(2, true, at());
  touch.up(2, at());
  touch.cancel(2);
  assert.ok(drain(touch).some((f) => f.buttons === 1));
  touch.down(3, true, at());
  touch.clear();
  assert.equal(touch.active, false);
  assert.equal(touch.sample().inside, false);
});
test('letterbox touches are ignored and pending contact released outside does not click', () => {
  const touch = new TouchMouse(() => 0);
  assert.equal(touch.down(1, true, at(0, 0, false)), false);
  touch.down(1, true, at());
  touch.sample();
  touch.up(1, at(100, 100, false));
  assert.ok(drain(touch).every((f) => f.buttons === 0));
});
test('touch gestures reach the unmodified native mouse release classifier', () => {
  let now = 0;
  const touch = new TouchMouse(() => now),
    s = new NoahState(() => 0);
  s.initialize();
  const native = new NoahInput(s);
  const run = () => {
    const frame = touch.sample();
    native.update({keys: new Set(), pressed: new Set(), wheel: 0, focused: true, ...frame});
    return s.get(0x17add90);
  };
  // Native mouse mode consumes its first click for activation, just as with a mouse.
  touch.down(1, true, at());
  touch.up(1, at());
  for (let i = 0; i < 5; i++) run();
  assert.equal(s.bytes(0x17add76, 1)[0], 1);
  touch.down(2, true, at());
  touch.up(2, at());
  assert.deepEqual(Array.from({length: 5}, run), [0, 0, 1, 0, 0]);
  touch.down(3, true, at());
  run();
  now = 500;
  assert.deepEqual(Array.from({length: 4}, run), [0, 2, 0, 0]);
  touch.up(3, at());
  assert.equal(run(), 0);
  touch.down(4, true, at());
  run();
  touch.down(5, false, at(500));
  assert.deepEqual(Array.from({length: 4}, run), [0, 2, 0, 0]);
  touch.up(4, at());
  touch.up(5, at(500));
  assert.equal(run(), 0);
});

test('second finger immediately emits one right click at the first finger, with either release order', () => {
  for (const order of [
    [1, 2],
    [2, 1],
  ]) {
    const touch = new TouchMouse(() => 0);
    touch.down(1, true, at());
    touch.sample();
    assert.equal(touch.down(2, false, at(500)), true);
    touch.move(2, at(600));
    assert.deepEqual(
      drain(touch).map((f) => [f.buttons, f.x]),
      [
        [2, 100],
        [0, 100],
        [0, 100],
        [0, 100],
        [0, 100],
      ],
    );
    touch.up(order[0], at());
    touch.cancel(order[0]); // Normal lostpointercapture after up.
    assert.equal(touch.active, true);
    touch.up(order[1], at());
    assert.equal(touch.active, false);
    assert.ok(drain(touch).every((f) => !f.buttons && !f.pressedButtons));
  }
});
test('two-finger press between ticks preserves right down/up and suppresses left tap', () => {
  const touch = new TouchMouse(() => 0);
  touch.down(1, true, at());
  touch.down(2, false, at(500));
  touch.up(2, at(500));
  touch.up(1, at());
  assert.deepEqual(
    drain(touch).map((f) => f.buttons),
    [0, 2, 0, 0, 0],
  );
});
test('extra fingers and long-press timeout cannot repeat a two-finger right click', () => {
  let now = 0;
  const touch = new TouchMouse(() => now);
  touch.down(1, true, at());
  touch.down(2, false, at());
  drain(touch);
  now = 1000;
  touch.down(3, false, at());
  touch.up(1, at());
  touch.up(2, at());
  assert.equal(touch.active, true);
  touch.down(4, false, at());
  touch.up(3, at());
  touch.up(4, at());
  assert.ok(drain(touch).every((f) => !f.buttons));
  touch.down(5, true, at());
  touch.sample();
  now = 1500;
  assert.equal(touch.sample().buttons, 2);
  touch.down(6, false, at());
  assert.ok(drain(touch).every((f) => !f.buttons));
});
test('a second finger cannot turn an established drag into a right click', () => {
  const touch = new TouchMouse(() => 0);
  touch.down(1, true, at());
  touch.move(1, at(200));
  drain(touch);
  touch.down(2, false, at(500));
  assert.equal(touch.sample().buttons, 1);
  touch.up(1, at(200));
  touch.up(2, at(500));
  assert.ok(drain(touch).every((f) => f.buttons !== 2));
  assert.equal(touch.sample().buttons, 0);
});
test('cancelling either captured finger clears a pending two-finger click', () => {
  for (const id of [1, 2]) {
    const touch = new TouchMouse(() => 0);
    touch.down(1, true, at());
    touch.down(2, false, at());
    touch.cancel(id);
    assert.equal(touch.active, false);
    assert.ok(drain(touch).every((f) => !f.buttons && !f.pressedButtons && !f.inside));
  }
});
