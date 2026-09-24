import test from 'node:test';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createGroup91FontRasterSettings} from '../dist/engines/buriko/games/aokana/native/group-91-font-raster-settings.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import assert from 'node:assert/strict';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {releaseAokanaHorizontalTextLayout} from '../dist/engines/buriko/games/aokana/native/text-layout-horizontal.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaTextLayoutState} from '../dist/engines/buriko/games/aokana/native/text-layout-state.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

function pointer(value) {
  const encoded = new TextEncoder().encode(value);
  const bytes = new Uint8Array(encoded.length + 1);
  bytes.set(encoded);
  return {bytes, offset: 0};
}

async function setup(size = 8) {
  const created = [];
  const text = new AokanaNativeText();
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
  const fonts = new AokanaNativeFonts(text, browser);
  fonts.rasterSettings.setQuality(-1);
  const selected = await fonts.get(new TextEncoder().encode('Synthetic'), size, 100, 0);
  assert.equal(selected.result, 0);
  const compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 2;
  const surfaces = new AokanaSurfaces(fonts, compositor, new AokanaDistributedAllocator(1));
  const state = new AokanaTextLayoutState(surfaces);
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

test('font raster settings affect real layout and reset at raster replacement', async () => {
  const {fonts, state, fontId} = await setup();
  const name = new TextEncoder().encode('Synthetic');
  const registeredFont = fonts.registerName(name, 0);
  const slots = createGroup91FontRasterSettings(fonts, {
    threadFatal() {
      assert.fail('ordinary font raster setting');
    },
  });
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const memory = new AokanaBpMemory(new Uint8Array(128));
  memory.globalMemory.set(name, 16);
  const context = {thread, memory, diagnostics: {}};
  async function invoke(secondary, args) {
    const slot = slots.find((entry) => entry.secondary === secondary);
    assert.equal(slot.primary, 0x91);
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x91][secondary]);
    for (const value of args) push32(thread, value);
    assert.equal(await slot.execute(context), 0);
    assert.equal(thread.stackIndex, 0);
  }
  async function layout(source, secondX, cursorX) {
    const result = await state.buildHorizontalText(options(state, fontId, source));
    try {
      assert.equal(result.result, 1);
      assert.deepEqual(
        result.nodes.map((node) => node.x),
        [0, secondX],
      );
      assert.deepEqual(result.cursor, {x: cursorX, y: 0});
      assert.equal(firstPixel(result.nodes[0].bitmap), 0xff445566);
    } finally {
      releaseAokanaHorizontalTextLayout(result.nodes);
    }
  }
  await invoke(0x0e, [16, 0x10000, 0x10000, 0, 0]);
  await invoke(0x0f, [registeredFont, 8, 100, 0, 3, 5]);
  await layout('AA', 7, 14);
  await layout('<i>AA</i>', 9, 18);
  await invoke(0x0e, [16, 0x10000, 0x10000, 0, 0]);
  await layout('AA', 7, 14);
  await invoke(0x0e, [16, 0x20000, 0x20000, 0, 0]);
  await layout('AA', 4, 8);
  await layout('<i>AA</i>', 4, 8);
  await invoke(0x0f, [registeredFont, 8, 100, 0, 3, 5]);
  await layout('AA', 7, 14);
  await fonts.rebuild();
  await layout('AA', 4, 8);
  await layout('<i>AA</i>', 4, 8);
  fonts.dispose();
});
