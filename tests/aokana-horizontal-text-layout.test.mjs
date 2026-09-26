import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {releaseBurikoHorizontalTextLayout} from '../dist/engines/buriko/native/text-layout-horizontal.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoTextLayoutState} from '../dist/engines/buriko/native/text-layout-state.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

function pointer(value) {
  const encoded = new TextEncoder().encode(value);
  const bytes = new Uint8Array(encoded.length + 1);
  bytes.set(encoded);
  return {bytes, offset: 0};
}

async function setup(size = 8) {
  const created = [];
  const text = new BurikoNativeText();
  const browser = {
    async queryCharset() {
      return 1;
    },
    async create(parameters) {
      created.push(parameters);
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
  const selected = await fonts.get(new TextEncoder().encode('Synthetic'), size, 100, 0);
  assert.equal(selected.result, 0);
  const compositor = new BurikoBitmapCompositor();
  compositor.defaultFormat = 2;
  const surfaces = new BurikoSurfaces(fonts, compositor, new BurikoDistributedAllocator(1));
  const state = new BurikoTextLayoutState(surfaces);
  return {created, fonts, state, fontId: selected.id};
}

function options(state, fontId, source, overrides = {}) {
  return {
    source: pointer(source),
    readingEnabled: 0,
    annotations: state.annotations,
    cursor: {x: 0, y: 0},
    rectangle: {left: 0, top: 0, right: 999, bottom: 999},
    lineAdvance: 8,
    fontId,
    proportional: 0,
    wrapping: 0,
    color: 0x445566,
    effect: {mode: 0, radiusXPercent: 25, radiusYPercent: 25, color: 0x010203, opacity: 0},
    ...overrides,
  };
}

function firstPixel(bitmap) {
  assert.notEqual(bitmap.storage, null);
  return bitmap.storage.view.getUint32(bitmap.offset, true);
}

test('horizontal preparation expands formatting, timing, events, and transient font styles', async () => {
  const {created, fonts, state, fontId} = await setup();
  const maximum = {value: 0};
  const result = await state.buildHorizontalText(
    options(
      state,
      fontId,
      '<c112233>A</c><t2><ev7><b>B</b><i>C</i><2x>D</2x><fs12>E</fs><mxfs16>F',
      {maximumFontSize: maximum},
    ),
  );
  try {
    assert.equal(result.result, 1);
    assert.deepEqual(
      result.nodes.map((node) => node.character),
      [65, null, 66, 67, 68, 69, 70],
    );
    assert.deepEqual(
      result.nodes.map((node) => node.revealTime),
      [0, 50, 50, 75, 100, 125, 150],
    );
    assert.deepEqual(
      result.nodes.map((node) => node.fontSize),
      [8, 0, 8, 8, 8, 12, 8],
    );
    assert.deepEqual(
      result.nodes.map((node) => node.x),
      [0, 0, 4, 8, 12, 16, 22],
    );
    assert.deepEqual(
      {event: result.nodes[1].y, cursor: result.cursor, maximum: result.maximumFontSize},
      {event: 7, cursor: {x: 26, y: 0}, maximum: 16},
    );
    assert.equal(maximum.value, 16);
    assert.equal(firstPixel(result.nodes[0].bitmap), 0xff112233);
    assert.equal(firstPixel(result.nodes[2].bitmap), 0xff445566);
    assert.equal(state.currentInlineColor, 0x445566);
    assert.ok(created.some((parameters) => parameters.italic));
    assert.ok(created.some((parameters) => parameters.weight === 700));
    assert.ok(created.some((parameters) => parameters.width === 8));
    assert.equal(fonts.records.length, 1);
  } finally {
    releaseBurikoHorizontalTextLayout(result.nodes);
  }
});

test('horizontal preparation handles carriage reset, paired ruby, and one escaped tag opener', async () => {
  const {state, fontId} = await setup();
  const result = await state.buildHorizontalText(
    options(state, fontId, 'A<cr>B<r xy>cd</r></><', {readingEnabled: 1}),
  );
  try {
    assert.deepEqual(
      result.nodes.map((node) => [node.character, node.x, node.revealTime]),
      [
        [65, 0, 0],
        [66, 0, 25],
        [99, 4, 50],
        [100, 8, 75],
        [60, 12, 100],
      ],
    );
    assert.equal(state.text.decodeAuto({bytes: result.nodes[2].annotationKey, offset: 0}), 'cd');
    assert.equal(result.nodes[3].annotationKey, null);
    assert.deepEqual(result.cursor, {x: 16, y: 0});
  } finally {
    releaseBurikoHorizontalTextLayout(result.nodes);
  }
});

test('horizontal wrapping keeps closing punctuation in the hanging margin after control 0B', async () => {
  const {state, fontId} = await setup();
  const result = await state.buildHorizontalText(
    options(state, fontId, '\u000bAB!!C', {
      wrapping: 1,
      rectangle: {left: 0, top: 0, right: 15, bottom: 99},
    }),
  );
  try {
    assert.deepEqual(
      result.nodes.map((node) => [node.character, node.x, node.y, node.line, node.revealTime]),
      [
        [65, 0, 0, 1, 0],
        [66, 4, 0, 1, 25],
        [33, 8, 0, 1, 50],
        [33, 12, 0, 1, 75],
        [67, 0, 8, 2, 100],
      ],
    );
    assert.deepEqual(
      {lineCount: result.lineCount, outputCount: result.outputCount, cursor: result.cursor},
      {lineCount: 2, outputCount: 2, cursor: {x: 4, y: 8}},
    );
  } finally {
    releaseBurikoHorizontalTextLayout(result.nodes);
  }
});

test('horizontal preparation preserves newline indentation, one-use ruby, and link ownership', async () => {
  const {state, fontId} = await setup();
  state.lineStartOffset = 2;
  state.linkColor = 0x102030;
  const result = await state.buildHorizontalText(
    options(state, fontId, 'A\n<ruby bc,xy>bc<l>de</l>', {
      readingEnabled: 1,
      wrapping: 1,
      rectangle: {left: 0, top: 0, right: 99, bottom: 99},
    }),
  );
  try {
    assert.deepEqual(
      result.nodes.map((node) => node.character),
      [65, 98, 99, 100, 101],
    );
    assert.deepEqual(
      result.nodes.map((node) => node.x),
      [2, 2, 6, 10, 14],
    );
    assert.deepEqual(
      result.nodes.map((node) => node.y),
      [4, 12, 12, 12, 12],
    );
    assert.deepEqual(
      {lineCount: result.lineCount, outputCount: result.outputCount, cursor: result.cursor},
      {lineCount: 2, outputCount: 2, cursor: {x: 18, y: 8}},
    );
    assert.equal(state.text.decodeAuto({bytes: result.nodes[1].annotationKey, offset: 0}), 'bc');
    assert.equal(result.nodes[1].annotationBaseExtent, 8);
    assert.equal(result.nodes[2].annotationKey, null);
    assert.deepEqual(
      state.linkRegions.map((link) => ({
        text: new TextDecoder().decode(link.text),
        x: link.x,
        y: link.y,
      })),
      [{text: 'de', x: 10, y: 8}],
    );
    assert.equal(firstPixel(result.nodes[3].bitmap), 0xff102030);
    assert.equal(state.currentInlineColor, 0x445566);
  } finally {
    releaseBurikoHorizontalTextLayout(result.nodes);
  }
});

test('positive-radius ordinary outline nodes publish dynamic per-line heights', async () => {
  const {state, fontId} = await setup(4);
  state.field1D1DBC = 1;
  const maximum = {value: 0};
  const result = await state.buildHorizontalText(
    options(state, fontId, '<mxfs8>A<ev7>B', {
      lineAdvance: 4,
      maximumFontSize: maximum,
      effect: {mode: 2, radiusXPercent: 25, radiusYPercent: 25, color: 0x010203, opacity: 0},
    }),
  );
  try {
    assert.equal(result.result, 1);
    assert.deepEqual(
      result.nodes.map((node) => [node.character, node.y]),
      [
        [65, 4],
        [null, 15],
        [66, 4],
      ],
    );
    assert.ok(result.nodes[0].auxiliary.storage !== null);
    assert.equal(result.nodes[1].auxiliary.storage, null);
    assert.ok(result.nodes[2].auxiliary.storage !== null);
    assert.deepEqual(result.lineHeights, [8]);
    assert.equal(result.maximumFontSize, 8);
    assert.equal(maximum.value, 8);
    assert.equal(result.outputCount, 1);
    assert.deepEqual(state.lineHeightLayouts.get(result.outputCount), [8]);
  } finally {
    releaseBurikoHorizontalTextLayout(result.nodes);
  }
});
