import test from 'node:test';
import assert from 'node:assert/strict';
import {allocateBurikoBitmap} from '../dist/engines/buriko/native/bitmap.js';
import {clearBurikoBitmap} from '../dist/engines/buriko/native/bitmap-copy.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {BurikoDisplayObjectEnvironment} from '../dist/engines/buriko/native/display-object.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoWindowDisplayObject} from '../dist/engines/buriko/native/display-window.js';
import {BurikoWindowDisplayState} from '../dist/engines/buriko/native/display-window-state.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoRubyAnnotations} from '../dist/engines/buriko/native/text-annotations.js';
import {releaseBurikoHorizontalTextLayout} from '../dist/engines/buriko/native/text-layout-horizontal.js';
import {BurikoTextLayoutState} from '../dist/engines/buriko/native/text-layout-state.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {
  BURIKO_DISABLED_HORIZONTAL_TEXT_EFFECT as effect,
  drawBurikoVerticalText,
  drawBurikoHorizontalTextToWindow,
} from '../dist/engines/buriko/native/text-layout-pipeline.js';
import {
  buildBurikoVerticalTextLayout,
  addBurikoVerticalReadings,
  alignBurikoVerticalTextNodes,
  rotateBurikoVerticalGlyph,
} from '../dist/engines/buriko/native/text-layout-vertical.js';

const pointer = (value) => ({
  bytes:
    typeof value === 'string'
      ? Uint8Array.from([...new TextEncoder().encode(value), 0])
      : Uint8Array.from([...value, 0]),
  offset: 0,
});

async function setup() {
  const text = new BurikoNativeText(),
    browser = {
      async queryCharset() {
        return 1;
      },
      async create(parameters) {
        const height = Math.abs(parameters.height);
        return {
          faceName: parameters.face,
          familyName: parameters.face,
          averageWidth: 0,
          ascent: height,
          abc() {
            return [0, Math.max(1, Math.trunc(height / 2)), 0];
          },
          extent() {
            return Math.max(1, Math.trunc(height / 2));
          },
          rasterText(_value, width, rasterHeight) {
            return {stride: width, bytes: new Uint8Array(width * rasterHeight).fill(255)};
          },
        };
      },
      dispose() {},
    },
    fonts = new BurikoNativeFonts(text, browser);
  fonts.rasterSettings.setQuality(-1);
  const name = new TextEncoder().encode('SyntheticVertical');
  assert.equal(fonts.registerName(name, 1), 0);
  const selected = await fonts.get(name, 8, 100, 0);
  assert.equal(selected.result, 0);
  const compositor = new BurikoBitmapCompositor();
  compositor.defaultFormat = 2;
  const surfaces = new BurikoSurfaces(fonts, compositor, new BurikoDistributedAllocator(1)),
    state = new BurikoTextLayoutState(surfaces);
  return {state, surfaces, fontId: selected.id};
}

test('vertical preparation, parent-local ruby, alignment and real window emission share native owners', async () => {
  const {state, surfaces, fontId} = await setup(),
    annotations = new BurikoRubyAnnotations(state.text),
    options = {
      source: pointer([65, 0x81, 0x41, 66]),
      readingEnabled: 0,
      annotations,
      cursor: {x: 31, y: 0},
      rectangle: {left: 0, top: 0, right: 31, bottom: 39},
      lineAdvance: 8,
      fontId,
      proportional: 0,
      wrapping: 0,
      color: 0x445566,
      effect,
    };
  let prepared = buildBurikoVerticalTextLayout(state, options);
  assert.deepEqual(
    prepared.nodes.map((n) => [n.kind, n.x, n.y, n.revealTime]),
    [
      [0, 24, 0, 0],
      [1, 29, 3, 25],
      [0, 24, 16, 50],
    ],
  );
  assert.deepEqual(options.cursor, {x: 31, y: 24});
  alignBurikoVerticalTextNodes(
    state,
    prepared.nodes,
    options.cursor,
    options.rectangle,
    fontId,
    0,
    1,
  );
  assert.deepEqual(
    prepared.nodes.map((n) => n.y),
    [7, 10, 23],
  );
  assert.deepEqual(options.cursor, {x: 31, y: 31});
  // f88c0's existing conversion success condition produces blank ordinary glyphs.
  assert.equal(
    prepared.nodes[0].bitmap.storage.bytes.every((value) => value === 0),
    true,
  );
  releaseBurikoHorizontalTextLayout(prepared.nodes);

  annotations.import(pointer('AB\\xy\n'));
  const rubyOptions = {...options, source: pointer('AB'), readingEnabled: 1, cursor: {x: 31, y: 0}};
  prepared = buildBurikoVerticalTextLayout(state, rubyOptions);
  // Configured horizontal reading offsets/width do not participate in 079F00.
  state.readingXOffset = 99;
  state.readingYOffset = 99;
  state.readingWidth = 37;
  assert.equal(
    await addBurikoVerticalReadings(state, prepared.nodes, fontId, 0x112233, effect, annotations),
    1,
  );
  assert.deepEqual(
    prepared.nodes.map((n) => [n.kind, n.x, n.y, n.revealTime]),
    [
      [0, 20, 0, 0],
      [2, 28, 0, 12],
      [2, 28, 4, 37],
      [0, 20, 8, 25],
    ],
  );
  assert.equal(prepared.outputCount, 1);
  assert.equal(prepared.nodes[0].next, prepared.nodes[1]);
  assert.equal(prepared.nodes[2].next, prepared.nodes[3]);
  releaseBurikoHorizontalTextLayout(prepared.nodes);
  annotations.clear();

  prepared = buildBurikoVerticalTextLayout(state, {
    ...options,
    source: pointer([65, 66, 10, 67]),
    cursor: {x: 31, y: 0},
    rectangle: {left: 0, top: 0, right: 31, bottom: 7},
  });
  assert.equal(prepared.outputCount, 3);
  assert.deepEqual(
    prepared.nodes.map((n) => [n.x, n.y]),
    [
      [24, 0],
      [16, 0],
      [8, 0],
    ],
  );
  releaseBurikoHorizontalTextLayout(prepared.nodes);

  const square = allocateBurikoBitmap(2, 2, 3);
  square.storage.bytes.set([1, 2, 3, 4]);
  square.storage.written(0, 4);
  assert.equal(rotateBurikoVerticalGlyph(square), true);
  assert.deepEqual([...square.storage.bytes], [3, 1, 4, 2]);
  square.storage.release();

  const destination = allocateBurikoBitmap(32, 40, 2);
  clearBurikoBitmap(destination);
  const output = {value: 77},
    count = {value: 88},
    cursor = {x: 31, y: 0},
    drawOptions = {
      ...options,
      destination,
      annotations: pointer('AB\\xy\n'),
      source: pointer('AB'),
      readingEnabled: 1,
      emittedOutput: count,
      lineOutput: output,
      cursor,
      alignment: 0,
      lineSpacingPercent: 0,
      readingColor: 0x112233,
    };
  assert.deepEqual(await drawBurikoVerticalText(state, {...drawOptions, fontId: 999}), {result: 0});
  assert.deepEqual([count.value, output.value, cursor], [88, 77, {x: 31, y: 0}]);
  const emitted = await drawBurikoVerticalText(state, drawOptions);
  assert.equal(emitted.result, 1);
  assert.equal(count.value, 4);
  assert.equal(output.value, 1);
  assert.deepEqual(emitted.rectangles, [
    {left: 20, top: 0, right: 27, bottom: 7},
    {left: 28, top: 0, right: 31, bottom: 3},
    {left: 28, top: 4, right: 31, bottom: 7},
    {left: 20, top: 8, right: 27, bottom: 15},
  ]);
  destination.storage.release();

  const environment = new BurikoDisplayObjectEnvironment(
      surfaces.compositor,
      new BurikoDisplayDamage(16, {left: 0, top: 0, right: 31, bottom: 23}),
    ),
    manager = new BurikoDisplayManager(environment, surfaces, new BurikoNativeDisplayState(32, 24)),
    windows = new BurikoWindowDisplayState(manager, state),
    window = new BurikoWindowDisplayObject(windows, 7);
  assert.equal(window.configureInitial(32, 24), 1);
  window.fontId = fontId;
  window.fontSize = 8;
  window.lineExtent = 17;
  assert.equal(window.setWritingDirection(1), 1);
  // EF40 takes the existing conversion bypass and exercises actual shared raster/compositor writes.
  assert.equal(
    await drawBurikoHorizontalTextToWindow(
      state,
      window,
      pointer([0xef, 0x40, 10, 0xef, 0x40]),
      0,
      0,
      0x445566,
      0x112233,
      effect,
    ),
    1,
  );
  assert.deepEqual(window.getTextCursor(), {x: 23, y: 8});
  assert.equal(window.lineExtent, 17);
  assert.equal(window.textBitmap.storage.view.getUint32(24 * 4, true), 0xff445566);
  assert.equal(window.textBitmap.storage.view.getUint32(16 * 4, true), 0xff445566);
  window.dispose();
});
