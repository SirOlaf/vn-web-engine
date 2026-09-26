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
import {createGroup91TextSettings} from '../dist/engines/buriko/games/aokana/native/group-91-text-settings.js';
import {createGroup91TextMetrics} from '../dist/engines/buriko/games/aokana/native/group-91-text-metrics.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

test('91 annotation collection and registered text measurement share drawing owners and bearing policy', async () => {
  const text = new AokanaNativeText();
  let created = 0;
  const browser = {
    async queryCharset() {
      return 1;
    },
    async create(parameters) {
      created++;
      const height = Math.abs(parameters.height);
      return {
        faceName: parameters.face,
        familyName: parameters.face,
        averageWidth: 0,
        ascent: height,
        abc() {
          return [0, height / 2, 0];
        },
        extent() {
          return height / 2;
        },
        rasterText(_value, width, rows) {
          return {stride: width, bytes: new Uint8Array(width * rows).fill(255)};
        },
      };
    },
    dispose() {},
  };
  const fonts = new AokanaNativeFonts(text, browser);
  fonts.rasterSettings.setQuality(-1);
  const registered = fonts.registerName(text.encodeWide('Synthetic', 1), 1);
  const surfaces = new AokanaSurfaces(
    fonts,
    new AokanaBitmapCompositor(),
    new AokanaDistributedAllocator(1),
  );
  const state = new AokanaTextLayoutState(surfaces),
    slots = createGroup91TextMetrics(state);
  const registration = createGroup91TextSettings(state, {}).find((slot) => slot.secondary === 0x94);
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 32,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const memory = new AokanaBpMemory(new Uint8Array(2048)),
    context = {thread, memory, diagnostics: {}};
  let nextText = 32;
  const put = (value) => {
    const encoded = text.encodeWide(value, 1),
      address = nextText;
    memory.globalMemory.set(encoded, address);
    nextText += encoded.length + 16;
    return address;
  };
  const call = async (secondary, ...values) => {
    values.forEach((value) => push32(thread, value));
    return (
      secondary === 0x94 ? registration : slots.find((slot) => slot.secondary === secondary)
    ).execute(context);
  };
  for (const slot of slots)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x91][slot.secondary]);
  const key = put('AB'),
    reading = put('reading'),
    source = put('AB AB'),
    output = 768;
  assert.equal(await call(0x94, key, reading), 0);
  assert.equal(await call(0x95, output, source), 0);
  assert.equal(pop32(thread), 2);
  assert.equal(
    text.decodeAuto({bytes: memory.globalMemory, offset: output}),
    'AB\\reading\nAB\\reading\n',
  );
  assert.equal(state.annotations.first.used, 0);

  const measured = 1024,
    phrase = put('AB'),
    view = new DataView(memory.globalMemory.buffer);
  assert.equal(await call(0x9b, measured, phrase, registered, 8, 100, 0, 0), 0);
  assert.equal(pop32(thread), 0);
  assert.equal(view.getInt32(measured, true), 8);
  assert.equal(await call(0x99, 2), 0);
  assert.equal(pop32(thread), 1);
  assert.equal(state.proportionalSideBearing, 32768);
  assert.equal(await call(0x9b, measured, phrase, registered, 8, 100, 0, 1), 0);
  assert.equal(pop32(thread), 0);
  // The filled raster spans all16 scratch columns. Cell8 gives margin4, left/right2:
  // two glyphs total2*(16+2+2), then native third metric excludes final right2.
  assert.equal(view.getInt32(measured, true), 38);
  assert.equal(await call(0x99, 0), 0);
  assert.equal(pop32(thread), 1);
  assert.equal(await call(0x9b, measured, phrase, registered, 8, 100, 0, 1), 0);
  assert.equal(pop32(thread), 0);
  assert.equal(view.getInt32(measured, true), 8);
  assert.equal(created, 1);
  assert.equal(thread.stackIndex, 0);
});
