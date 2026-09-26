import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoDisplayObjectEnvironment} from '../dist/engines/buriko/native/display-object.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoWindowDisplayState} from '../dist/engines/buriko/native/display-window-state.js';
import {BurikoWindowDisplayObject} from '../dist/engines/buriko/native/display-window.js';
import {BurikoTextLayoutState} from '../dist/engines/buriko/native/text-layout-state.js';

const bytes = (value) => new TextEncoder().encode(value);
function setup() {
  const created = [];
  // Only host font selection metadata is needed; no glyph or browser canvas is requested.
  const fonts = new BurikoNativeFonts(new BurikoNativeText(), {
    async queryCharset() {
      return 1;
    },
    async create(parameters) {
      created.push(parameters);
      return {
        faceName: parameters.face,
        familyName: parameters.face,
        averageWidth: 20,
        ascent: 20,
      };
    },
  });
  const compositor = new BurikoBitmapCompositor();
  const surfaces = new BurikoSurfaces(fonts, compositor, new BurikoDistributedAllocator(1));
  const manager = new BurikoDisplayManager(
    new BurikoDisplayObjectEnvironment(
      compositor,
      new BurikoDisplayDamage(32, {left: 0, top: 0, right: 799, bottom: 599}),
    ),
    surfaces,
    new BurikoNativeDisplayState(800, 600),
  );
  const state = new BurikoWindowDisplayState(manager);
  const window = new BurikoWindowDisplayObject(state, 0);
  assert.equal(window.configureInitial(64, 96), 1);
  window.setTextRectangle({left: 4, top: 6, right: 63, bottom: 95});
  return {fonts, created, state, window};
}

test('window font selection uses actual shared records and clamps only the extended right edge', async () => {
  const {fonts, created, window} = setup();
  window.setWritingDirection(1);
  window.setTextRightExtension(7);
  window.setTextCursor(42, 25);
  const first = window.configureFont(bytes('Synthetic'), 13, 75, 1);
  assert.equal(window.fontId, 0);
  assert.equal(await first, 0);
  assert.equal(fonts.records.length, 1);
  assert.equal(window.fontId, fonts.records[0].id);
  assert.deepEqual([window.fontSize, window.fontWidth, window.lineExtent], [13, 9, 13]);
  assert.deepEqual(window.getTextRectangle(), {left: 4, top: 6, right: 54, bottom: 95});
  assert.equal(window.getTextRectangle(true).right, 67);
  assert.deepEqual(window.getTextCursor(), {x: 54, y: 6});
  window.setTextCursor(33, 17);
  window.setLineExtent(21);
  assert.equal(await window.configureFont(bytes('Synthetic'), 13, 75, 1), 0);
  assert.equal(created.length, 1);
  assert.equal(window.lineExtent, 13);
  assert.deepEqual(window.getTextCursor(), {x: 33, y: 17});
});

test('line spacing and line movement preserve native rounding and share the global start offset', async () => {
  const {window, state} = setup();
  await window.configureFont(bytes('Synthetic'), 13, 100, 0);
  window.setLineSpacing(50);
  assert.deepEqual(
    [window.textLineGap(), window.textLineAdvance(), window.textLineCount()],
    [6, 19, 4],
  );
  window.setTextCursor(25, 8);
  assert.equal(window.newTextLine(), 1);
  assert.deepEqual(window.getTextCursor(), {x: 4, y: 27});
  assert.equal(window.atTextLineStart(), 1);
  assert.equal(state.textLayout.configure(25, 150, 0, 40, 3, 0), 0);
  assert.equal(window.atTextLineStart(), 0);
  window.advanceTextCursor(3);
  assert.equal(window.atTextLineStart(), 1);
  const second = new BurikoWindowDisplayObject(state, 1);
  second.configureInitial(64, 96);
  second.setWritingDirection(1);
  second.setTextCursor(63, 3);
  assert.equal(second.atTextLineStart(), 1);
  window.setWritingDirection(1);
  assert.equal(window.newTextLine(), 1);
  assert.deepEqual(window.getTextCursor(), {x: 44, y: 6});
  assert.equal(window.textLineCount(), 4);
  window.advanceTextCursor(3);
  assert.equal(window.atTextLineStart(), 1);
  window.setCharacterSpacing(-2);
  assert.equal(window.characterSpacing, -2);
});

test('shared text layout defaults and successful updates retain the native publication order', () => {
  const state = setup().state.textLayout,
    events = [];
  const fields = [
    'field1C9100',
    'field1D1E48',
    'field1C90EC',
    'field1C90E8',
    'field1D1E4C',
    'lineStartOffset',
  ];
  assert.deepEqual(
    fields.map((field) => state[field]),
    [25, 0, 40, 150, 0, 0],
  );
  for (const field of fields) {
    let value = state[field];
    Object.defineProperty(state, field, {
      get() {
        return value;
      },
      set(next) {
        events.push([field, next]);
        value = next;
      },
    });
  }
  assert.equal(state.configure(30, 0, 7, 100, 2, 4), 0);
  assert.deepEqual(
    events,
    fields.map((field, index) => [field, [30, 7, 100, 1, 4, 2][index]]),
  );
});
