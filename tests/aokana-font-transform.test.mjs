import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaTextLayoutState} from '../dist/engines/buriko/games/aokana/native/text-layout-state.js';
import {
  measureAokanaHorizontalWideText,
  releaseAokanaHorizontalTextLayout,
} from '../dist/engines/buriko/games/aokana/native/text-layout-horizontal.js';
import {createGroup92FontTransform} from '../dist/engines/buriko/games/aokana/native/group-92-font-transform.js';
import {createGroup91TextMetrics} from '../dist/engines/buriko/games/aokana/native/group-91-text-metrics.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

test('92 font transforms feed cached glyph layout, measured bearings, and actual node pixels', async () => {
  const text = new AokanaNativeText();
  let created = 0,
    rasterized = 0;
  const fonts = new AokanaNativeFonts(text, {
    async queryCharset() {
      return 1;
    },
    async create(parameters) {
      created++;
      return {
        faceName: parameters.face,
        familyName: parameters.face,
        averageWidth: 8,
        ascent: 8,
        abc() {
          return [0.25, 6, 0.75];
        },
        extent() {
          return 8;
        },
        rasterText(_value, width, height) {
          rasterized++;
          const bytes = new Uint8Array(width * height);
          for (let y = 0; y < height; y++)
            bytes.fill(255, y * width, y * width + Math.min(8, width));
          return {stride: width, bytes};
        },
      };
    },
    dispose() {},
  });
  fonts.rasterSettings.setQuality(-1);
  const compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 2;
  const surfaces = new AokanaSurfaces(fonts, compositor, new AokanaDistributedAllocator(1));
  const state = new AokanaTextLayoutState(surfaces);
  const slots = createGroup92FontTransform(fonts, {
    threadFatal() {
      assert.fail('ordinary transform succeeds');
    },
  });
  const memory = new AokanaBpMemory(new Uint8Array(256));
  memory.globalMemory.set(text.encodeWide('Synthetic', 0), 16);
  const vector = new DataView(memory.globalMemory.buffer, 64, 20);
  [65536, 65536, 0, 0, 0].forEach((value, index) => vector.setInt32(index * 4, value, true));
  memory.globalMemory.set([0xef, 0x40, 0xef, 0x41, 0], 128);
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 32,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const context = {thread, memory, diagnostics: {}};
  const call = async (secondary, ...values) => {
    values.forEach((value) => push32(thread, value));
    assert.equal(await slots.find((slot) => slot.secondary === secondary).execute(context), 0);
  };
  for (const slot of slots)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x92][slot.secondary]);
  await call(0x0e, 16, 4, 64);
  const selected = await fonts.get(text.encodeWide('Synthetic', 0), 8, 100, 0);
  assert.equal(selected.result, 0);
  const font = fonts.find(selected.id);
  const source = {bytes: memory.globalMemory, offset: 128};
  const wide = state.customGlyphs.decode(source);
  assert.equal(wide, '\uef40\uef41');
  const layout = async (proportional, positions, cursor) => {
    const result = await state.buildHorizontalText({
      source,
      readingEnabled: 0,
      annotations: state.annotations,
      cursor: {x: 0, y: 0},
      rectangle: {left: 0, top: 0, right: 100, bottom: 32},
      lineAdvance: 8,
      fontId: selected.id,
      proportional,
      wrapping: 0,
      color: 0x123456,
      effect: {mode: 0, radiusXPercent: 0, radiusYPercent: 0, color: 0, opacity: 0},
    });
    try {
      assert.equal(result.result, 1);
      assert.deepEqual(
        result.nodes.map((node) => node.x),
        positions,
      );
      assert.equal(result.cursor.x, cursor);
      for (const node of result.nodes) {
        assert.equal(node.bitmap.storage.view.getUint32(node.bitmap.offset, true), 0xff123456);
      }
    } finally {
      releaseAokanaHorizontalTextLayout(result.nodes);
    }
  };
  const measured = (proportional) =>
    measureAokanaHorizontalWideText(state, wide, font, proportional);
  await layout(0, [0, 8], 16);
  assert.deepEqual(measured(0), {total: 16, withoutLastBearing: 16, withoutFirstBearing: 16});
  const cachedRasters = rasterized;
  await call(0x0f, 16, 32768);
  // size8 * one-half =4 additional pixels for every glyph, including the final one.
  await layout(0, [0, 12], 24);
  assert.deepEqual(measured(0), {total: 24, withoutLastBearing: 24, withoutFirstBearing: 24});
  // Count5 changes only spacing. Fractional extra0.5 must survive until ABC rounding.
  vector.setInt32(16, 4096, true);
  await call(0x0e, 16, 5, 64);
  push32(thread, 0);
  assert.equal(
    createGroup91TextMetrics(state)
      .find((slot) => slot.secondary === 0x99)
      .execute(context),
    0,
  );
  assert.equal(pop32(thread), 1);
  // A=.25, B=6, C=.75: left0, body7, right=trunc(-.75+.75+.5+.5)=1.
  await layout(1, [0, 8], 16);
  assert.deepEqual(measured(1), {total: 16, withoutLastBearing: 15, withoutFirstBearing: 15});
  assert.equal(created, 1);
  assert.equal(rasterized, cachedRasters);
  assert.equal(thread.stackIndex, 0);
});
