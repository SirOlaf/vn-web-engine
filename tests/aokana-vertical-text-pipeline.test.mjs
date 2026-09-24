import test from 'node:test';
import assert from 'node:assert/strict';
import {allocateAokanaBitmap} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {clearAokanaBitmap} from '../dist/engines/buriko/games/aokana/native/bitmap-copy.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaWindowDisplayObject} from '../dist/engines/buriko/games/aokana/native/display-window.js';
import {AokanaWindowDisplayState} from '../dist/engines/buriko/games/aokana/native/display-window-state.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaRubyAnnotations} from '../dist/engines/buriko/games/aokana/native/text-annotations.js';
import {releaseAokanaHorizontalTextLayout} from '../dist/engines/buriko/games/aokana/native/text-layout-horizontal.js';
import {AokanaTextLayoutState} from '../dist/engines/buriko/games/aokana/native/text-layout-state.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {
  AOKANA_DISABLED_HORIZONTAL_TEXT_EFFECT as effect,
  drawAokanaVerticalText,
  drawAokanaHorizontalTextToWindow,
} from '../dist/engines/buriko/games/aokana/native/text-layout-pipeline.js';
import {
  buildAokanaVerticalTextLayout,
  addAokanaVerticalReadings,
  alignAokanaVerticalTextNodes,
  rotateAokanaVerticalGlyph,
} from '../dist/engines/buriko/games/aokana/native/text-layout-vertical.js';

const pointer = (value) => ({
  bytes:
    typeof value === 'string'
      ? Uint8Array.from([...new TextEncoder().encode(value), 0])
      : Uint8Array.from([...value, 0]),
  offset: 0,
});

async function setup() {
  const text = new AokanaNativeText(),
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
    fonts = new AokanaNativeFonts(text, browser);
  fonts.rasterSettings.setQuality(-1);
  const name = new TextEncoder().encode('SyntheticVertical');
  assert.equal(fonts.registerName(name, 1), 0);
  const selected = await fonts.get(name, 8, 100, 0);
  assert.equal(selected.result, 0);
  const compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 2;
  const surfaces = new AokanaSurfaces(fonts, compositor, new AokanaDistributedAllocator(1)),
    state = new AokanaTextLayoutState(surfaces);
  return {state, surfaces, fontId: selected.id};
}

test('vertical preparation, parent-local ruby, alignment and real window emission share native owners', async () => {
  const {state, surfaces, fontId} = await setup(),
    annotations = new AokanaRubyAnnotations(state.text),
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
  let prepared = buildAokanaVerticalTextLayout(state, options);
  assert.deepEqual(
    prepared.nodes.map((n) => [n.kind, n.x, n.y, n.revealTime]),
    [
      [0, 24, 0, 0],
      [1, 29, 3, 25],
      [0, 24, 16, 50],
    ],
  );
  assert.deepEqual(options.cursor, {x: 31, y: 24});
  alignAokanaVerticalTextNodes(
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
  releaseAokanaHorizontalTextLayout(prepared.nodes);

  annotations.import(pointer('AB\\xy\n'));
  const rubyOptions = {...options, source: pointer('AB'), readingEnabled: 1, cursor: {x: 31, y: 0}};
  prepared = buildAokanaVerticalTextLayout(state, rubyOptions);
  // Configured horizontal reading offsets/width do not participate in 079F00.
  state.readingXOffset = 99;
  state.readingYOffset = 99;
  state.readingWidth = 37;
  assert.equal(
    await addAokanaVerticalReadings(state, prepared.nodes, fontId, 0x112233, effect, annotations),
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
  releaseAokanaHorizontalTextLayout(prepared.nodes);
  annotations.clear();

  prepared = buildAokanaVerticalTextLayout(state, {
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
  releaseAokanaHorizontalTextLayout(prepared.nodes);

  const square = allocateAokanaBitmap(2, 2, 3);
  square.storage.bytes.set([1, 2, 3, 4]);
  square.storage.written(0, 4);
  assert.equal(rotateAokanaVerticalGlyph(square), true);
  assert.deepEqual([...square.storage.bytes], [3, 1, 4, 2]);
  square.storage.release();

  const destination = allocateAokanaBitmap(32, 40, 2);
  clearAokanaBitmap(destination);
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
  assert.deepEqual(await drawAokanaVerticalText(state, {...drawOptions, fontId: 999}), {result: 0});
  assert.deepEqual([count.value, output.value, cursor], [88, 77, {x: 31, y: 0}]);
  const emitted = await drawAokanaVerticalText(state, drawOptions);
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

  const environment = new AokanaDisplayObjectEnvironment(
      surfaces.compositor,
      new AokanaDisplayDamage(16, {left: 0, top: 0, right: 31, bottom: 23}),
    ),
    manager = new AokanaDisplayManager(environment, surfaces, new AokanaNativeDisplayState(32, 24)),
    windows = new AokanaWindowDisplayState(manager, state),
    window = new AokanaWindowDisplayObject(windows, 7);
  assert.equal(window.configureInitial(32, 24), 1);
  window.fontId = fontId;
  window.fontSize = 8;
  window.lineExtent = 17;
  assert.equal(window.setWritingDirection(1), 1);
  // EF40 takes the existing conversion bypass and exercises actual shared raster/compositor writes.
  assert.equal(
    await drawAokanaHorizontalTextToWindow(
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
