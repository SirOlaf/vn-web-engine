import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
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
import {createHorizontalTextLayoutServices} from '../dist/engines/buriko/native/group-text-layout-settings.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoRubyAnnotations} from '../dist/engines/buriko/native/text-annotations.js';
import {
  BURIKO_DISABLED_HORIZONTAL_TEXT_EFFECT,
  addBurikoHorizontalReadings,
  alignBurikoHorizontalTextNodes,
  drawBurikoHorizontalText,
  drawBurikoHorizontalTextToWindow,
  emitBurikoHorizontalTextNodes,
} from '../dist/engines/buriko/native/text-layout-pipeline.js';
import {releaseBurikoHorizontalTextLayout} from '../dist/engines/buriko/native/text-layout-horizontal.js';
import {BurikoTextLayoutState} from '../dist/engines/buriko/native/text-layout-state.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

function pointer(value) {
  const encoded = new TextEncoder().encode(value);
  const bytes = new Uint8Array(encoded.length + 1);
  bytes.set(encoded);
  return {bytes, offset: 0};
}

async function setup(size = 8) {
  const text = new BurikoNativeText();
  const browser = {
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
  };
  const fonts = new BurikoNativeFonts(text, browser);
  fonts.rasterSettings.setQuality(-1);
  const name = new TextEncoder().encode('Synthetic');
  assert.equal(fonts.registerName(name, 1), 0);
  const selected = await fonts.get(name, size, 100, 0);
  assert.equal(selected.result, 0);
  const compositor = new BurikoBitmapCompositor();
  compositor.defaultFormat = 2;
  const surfaces = new BurikoSurfaces(fonts, compositor, new BurikoDistributedAllocator(1));
  const state = new BurikoTextLayoutState(surfaces);
  return {fonts, state, surfaces, fontId: selected.id};
}

function preparedOptions(state, fontId, source, annotations) {
  return {
    source: pointer(source),
    readingEnabled: 1,
    annotations,
    cursor: {x: 0, y: 0},
    rectangle: {left: 0, top: 0, right: 27, bottom: 11},
    lineAdvance: 8,
    fontId,
    proportional: 0,
    wrapping: 0,
    color: 0x445566,
    effect: BURIKO_DISABLED_HORIZONTAL_TEXT_EFFECT,
  };
}

test('reading chains splice after their own parents and share each line alignment offset', async () => {
  const {state, fontId} = await setup();
  const annotations = new BurikoRubyAnnotations(state.text);
  annotations.import(pointer('AB\\xy\nCD\\uv\n'));
  const options = preparedOptions(state, fontId, 'ABCD', annotations);
  options.rectangle.right = 35;
  const prepared = await state.buildHorizontalText(options);
  const destination = allocateBurikoBitmap(36, 12, 2);
  clearBurikoBitmap(destination);
  try {
    assert.equal(
      await addBurikoHorizontalReadings(
        state,
        prepared.nodes,
        fontId,
        0x112233,
        BURIKO_DISABLED_HORIZONTAL_TEXT_EFFECT,
        annotations,
      ),
      1,
    );
    assert.deepEqual(
      prepared.nodes.map((node) => [node.kind, node.character, node.x, node.y]),
      [
        [0, 65, 0, 4],
        [2, 120, -4, 0],
        [2, 121, 4, 0],
        [0, 66, 4, 4],
        [0, 67, 8, 4],
        [2, 117, 4, 0],
        [2, 118, 12, 0],
        [0, 68, 12, 4],
      ],
    );
    alignBurikoHorizontalTextNodes(
      state,
      prepared.nodes,
      options.cursor,
      options.rectangle,
      fontId,
      0,
      BURIKO_DISABLED_HORIZONTAL_TEXT_EFFECT,
      1,
    );
    assert.deepEqual(
      prepared.nodes.map((node) => node.x),
      [4, 0, 8, 8, 12, 8, 16, 16],
    );
    assert.deepEqual(options.cursor, {x: 20, y: 0});
    const rectangles = emitBurikoHorizontalTextNodes(state, destination, prepared.nodes);
    assert.equal(rectangles.length, 8);
    assert.deepEqual(
      [rectangles[1], rectangles[2], rectangles[5], rectangles[6]],
      [
        {left: 0, top: 0, right: 2, bottom: 3},
        {left: 8, top: 0, right: 10, bottom: 3},
        {left: 8, top: 0, right: 10, bottom: 3},
        {left: 16, top: 0, right: 18, bottom: 3},
      ],
    );
  } finally {
    destination.storage.release();
    releaseBurikoHorizontalTextLayout(prepared.nodes);
    annotations.clear();
  }
});

test('top-level horizontal orchestration leaves outputs untouched on font miss and emits on success', async () => {
  const {state, fontId} = await setup();
  const destination = allocateBurikoBitmap(20, 12, 2);
  clearBurikoBitmap(destination);
  const lineOutput = {value: 77},
    emittedOutput = {value: 88},
    cursor = {x: 0, y: 0},
    common = {
      destination,
      emittedOutput,
      lineOutput,
      cursor,
      rectangle: {left: 0, top: 0, right: 19, bottom: 11},
      source: pointer('AB'),
      readingEnabled: 1,
      annotations: pointer('AB\\xy\n'),
      proportional: 0,
      wrapping: 0,
      alignment: 0,
      lineSpacingPercent: 0,
      color: 0x445566,
      readingColor: 0x112233,
      effect: BURIKO_DISABLED_HORIZONTAL_TEXT_EFFECT,
    };
  try {
    assert.deepEqual(await drawBurikoHorizontalText(state, {...common, fontId: 999}), {result: 0});
    assert.deepEqual(
      {emitted: emittedOutput.value, line: lineOutput.value, cursor},
      {emitted: 88, line: 77, cursor: {x: 0, y: 0}},
    );
    const drawn = await drawBurikoHorizontalText(state, {...common, fontId});
    assert.equal(drawn.result, 1);
    assert.equal(drawn.emittedCount, 4);
    assert.deepEqual(drawn.rectangles, [
      {left: 0, top: 4, right: 15, bottom: 15},
      {left: -4, top: 0, right: -2, bottom: 3},
      {left: 4, top: 0, right: 6, bottom: 3},
      {left: 4, top: 4, right: 19, bottom: 15},
    ]);
    assert.deepEqual(
      {emitted: emittedOutput.value, line: lineOutput.value, cursor},
      {emitted: 4, line: 1, cursor: {x: 8, y: 0}},
    );
  } finally {
    destination.storage.release();
  }
});

test('the horizontal window caller commits cursor and text through the existing window owner', async () => {
  const {state, surfaces, fontId} = await setup();
  const environment = new BurikoDisplayObjectEnvironment(
      surfaces.compositor,
      new BurikoDisplayDamage(16, {left: 0, top: 0, right: 31, bottom: 19}),
    ),
    manager = new BurikoDisplayManager(environment, surfaces, new BurikoNativeDisplayState(32, 20)),
    windows = new BurikoWindowDisplayState(manager, state),
    window = new BurikoWindowDisplayObject(windows, 7);
  assert.equal(window.configureInitial(32, 20), 1);
  window.fontId = fontId;
  window.fontSize = 8;
  window.lineExtent = 8;
  assert.equal(
    await drawBurikoHorizontalTextToWindow(
      state,
      window,
      pointer('A'),
      0,
      0,
      0x445566,
      0x112233,
      BURIKO_DISABLED_HORIZONTAL_TEXT_EFFECT,
    ),
    1,
  );
  assert.deepEqual(window.getTextCursor(), {x: 4, y: 0});
  assert.equal(window.lineExtent, 8);
  assert.equal(window.textBitmap.storage.view.getUint32(0, true), 0xff445566);
  window.dispose();
});

test('six installed wrappers expose exact addresses and the ordinary 91:9C surface call pushes line output', async () => {
  const {state, surfaces} = await setup();
  assert.equal(surfaces.allocate(7, 20, 12, 2), 1);
  const slots = createHorizontalTextLayoutServices(
    {textLayout: state},
    {
      threadFatal() {
        assert.fail('ordinary horizontal text wrapper should not raise a thread error');
      },
    },
  );
  assert.deepEqual(
    slots.map((slot) => [slot.primary, slot.secondary, slot.nativeAddress]),
    [
      [0x91, 0x91, 0x1400df330],
      [0x91, 0x93, 0x1400df100],
      [0x92, 0x91, 0x1400e38c0],
      [0x91, 0x9c, 0x1400deaf0],
      [0x91, 0x9d, 0x1400de840],
      [0x92, 0x9c, 0x1400e3210],
    ],
  );

  const global = new Uint8Array(128);
  global.set(new TextEncoder().encode('A'), 16);
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 32,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {
    thread,
    memory: new BurikoBpMemory(global),
    diagnostics: {},
  };
  for (const argument of [7, 0, 0, 16, 0, 64, 0, 8, 100, 0, 0, 0, 0, 0x445566])
    push32(thread, argument);
  const service = slots.find((slot) => slot.primary === 0x91 && slot.secondary === 0x9c);
  assert.equal(await service.execute(context), 0);
  assert.equal(pop32(thread), 1);
  surfaces.release(7);
});
