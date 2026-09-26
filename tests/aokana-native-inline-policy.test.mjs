import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BurikoInlineTextState,
  burikoInlineTextWidth,
} from '../dist/engines/buriko/native/inline-text-state.js';
import {
  burikoDisplayViewport,
  burikoDisplayScaleSize,
  burikoDisplayTransformRectangle,
} from '../dist/engines/buriko/native/display-geometry.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoCrtRandom} from '../dist/engines/buriko/native/system-timing.js';
import {burikoShakeRandom, burikoShakeTarget} from '../dist/engines/buriko/native/shake-math.js';

function display() {
  const value = new BurikoNativeDisplayState(1920, 1080);
  value.requestedWidth = 1200;
  value.requestedHeight = 900;
  return value;
}

test('inline width counts supplementary Unicode once and preserves the native half-width ranges', () => {
  assert.equal(burikoInlineTextWidth('A日\uff76\ud83d\ude00\ud800'), 8);
  assert.equal(burikoInlineTextWidth('A\0日本'), 1);
  assert.equal(burikoInlineTextWidth('\x7f\x80\uff60\uff61\uff9f\uffa0'), 9);
});

test('inline WM_CHAR distinguishes full-width filtering, editing controls, selection and paste', () => {
  const state = new BurikoInlineTextState();
  state.limit = 4;
  assert.equal(state.character(65, '日本', 0, 1), 'default');
  assert.equal(state.character(65, '日本', 2, 2), 'consume');
  state.rejectAscii = 1;
  assert.equal(state.character(65, '', 0, 0), 'consume');
  assert.equal(state.character(0x7f, '', 0, 0), 'consume');
  assert.equal(state.character(0x16, '', 0, 0, 'ABCD'), 'default');
  assert.equal(state.character(0x16, '', 0, 0, '日本A'), 'consume');
  for (const control of [3, 8, 24])
    assert.equal(state.character(control, 'a'.repeat(2000), 0, 2000), 'default');
  for (const control of [0, 9, 26, 27]) assert.equal(state.character(control, '', 0, 0), 'consume');
  assert.equal(state.character(13, '', 0, 0), 'submit');
  assert.throws(() => state.character(0x16, '', 0, 0, 'a'.repeat(1024)), /clipboard.*stack/);
  assert.throws(() => state.character(0x3042, 'a'.repeat(2000), 1020, 1030), /unwritten/);
  state.rejectAscii = 0;
  state.limit = 1024;
  assert.equal(state.character(65, 'a'.repeat(2000), 0, 0), 'default');
});

test('inline specification validates in native order without performing later lifecycle geometry', () => {
  const state = new BurikoInlineTextState(),
    d = display(),
    fonts = {
      name(id) {
        return id === 2 ? Uint8Array.of(65) : null;
      },
    };
  const spec = (width, height, font, size, limit) =>
    state.specification(d, fonts, -3, 8, width, height, font, size, limit, 1);
  assert.equal(spec(7, 20, 99, 0, 0).result, 1);
  assert.equal(spec(20, 20, 99, 0, 0).result, 2);
  assert.equal(spec(20, 20, 2, 7, 0).result, 3);
  assert.equal(spec(20, 20, 2, 8, 0).result, 4);
  const good = spec(20, 20, 2, 8, 256);
  assert.equal(good.result, 0);
  assert.deepEqual(good.value.nativeRectangle, [-3, 8, 16, 27]);
  assert.equal(good.value.multiline, true);
  assert.equal(state.setAlignment(-1), 0);
  assert.equal(state.setAlignment(2), 1);
  assert.equal(state.setWidthPercent(200), 1);
  assert.equal(state.setWidthPercent(201), 0);
  state.setColor(0x12345678);
  assert.equal(state.textColorBgr, 0x785634);
});

test('viewport scaling preserves odd fit margins, wrapping products and half-open caller corners', () => {
  const d = display();
  assert.deepEqual(burikoDisplayTransformRectangle(d, [2, 3, 22, 23]), [3, 4, 33, 34]);
  assert.deepEqual(burikoDisplayScaleSize(d, 20, 24), [30, 36]);
  assert.deepEqual(burikoDisplayScaleSize(d, 0x80000000, 1), [0, 1]);
  d.fullscreen = 1;
  d.desktopWidth = 1001;
  d.desktopHeight = 751;
  assert.deepEqual(burikoDisplayViewport(d), [0, 0, 1000, 750]);
  d.desktopHeight = 750;
  assert.deepEqual(burikoDisplayViewport(d), [0, 0, 1000, 749]);
  assert.equal(burikoDisplayScaleSize(d, 800, 600)[0], 1001);
  d.displayMode = 2;
  assert.deepEqual(burikoDisplayViewport(d), [100, 75, 900, 674]);
  d.displayMode = 3;
  assert.throws(() => burikoDisplayViewport(d), /unwritten/);
});

test('shake targets consume exactly thirty-two shared CRT draws including invalid quadrants', () => {
  const expected = new BurikoCrtRandom(),
    actual = new BurikoCrtRandom();
  expected.seed(123);
  actual.seed(123);
  const pair = burikoShakeTarget(actual, 3, 100, 0, [10, 20]);
  assert.ok(pair[0] >= 0 && pair[0] <= 100);
  assert.ok(pair[1] <= 0 && pair[1] >= -100);
  for (let i = 0; i < 32; i++) expected.next();
  assert.equal(actual.next(), expected.next());
  assert.deepEqual(burikoShakeTarget(actual, 3, 0, 0, [10, 20]), [0, 0]);
  assert.deepEqual(burikoShakeTarget(actual, 2, 100, 0, [10, 20]), [10, 20]);
  assert.equal(actual.next(), expected.next());
  assert.deepEqual(burikoShakeTarget(actual, 3, 100, 4, [10, 20]), [10, 20]);
  for (let i = 0; i < 32; i++) expected.next();
  assert.equal(actual.next(), expected.next());
  assert.throws(() => burikoShakeRandom(actual, -1), /IDIV/);
  expected.next();
  expected.next();
  assert.equal(actual.next(), expected.next());
});
