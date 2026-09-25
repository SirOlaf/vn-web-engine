import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaTextLayoutState} from '../dist/engines/buriko/games/aokana/native/text-layout-state.js';
import {createTextLayoutSettings} from '../dist/engines/buriko/games/aokana/native/group-text-layout-settings.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

function setup() {
  const text = new AokanaNativeText(),
    fonts = new AokanaNativeFonts(text),
    compositor = new AokanaBitmapCompositor(),
    surfaces = new AokanaSurfaces(fonts, compositor, new AokanaDistributedAllocator(1)),
    state = new AokanaTextLayoutState(surfaces);
  compositor.defaultFormat = 1;
  return {text, fonts, compositor, surfaces, state};
}
const pointer = (bytes) => ({bytes, offset: 0});
const ids = (...values) => pointer(new Uint8Array(Uint32Array.from(values).buffer));
const firstPixel = (bitmap) => bitmap.storage.view.getUint32(bitmap.offset, true);

test('reading-font settings preserve name tails, publication order, registered names and native size rounding', () => {
  const {text, fonts, state} = setup();
  const fields = [
      'readingYOffset',
      'readingValue1C90F8',
      'readingValue1C90F4',
      'readingFontSize',
      'readingXOffset',
      'readingWidth',
    ],
    events = [];
  assert.deepEqual(
    fields.map((field) => state[field]),
    [0, 0xffffffff, 0xffffffff, 0, 0, 0],
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
  state.setReadingFont(pointer(text.encodeWide('abcdef', 1)), 13, 75, 2, -3, 0x102030, 0x405060);
  assert.deepEqual(
    events,
    fields.map((field, index) => [field, [-3, 0x102030, 0x405060, 13, 2, 75][index]]),
  );
  state.setReadingFont(pointer(text.encodeWide('Q', 1)), 0, 50, 4, 5, 0xffffffff, 0xffffffff);
  assert.deepEqual(Array.from(state.readingFontName.subarray(0, 7)), [81, 0, 99, 100, 101, 102, 0]);
  assert.equal(state.readingSize(13), 5);
  assert.equal(state.readingSize(6), 4);
  const registered = fonts.registerName(text.encodeWide('Selected', 1), 1);
  assert.equal(state.setRegisteredReadingFont(registered, 9, 80, 1, 2, 3, 4), 0);
  assert.equal(text.decodeAuto(pointer(state.readingFontName)), 'Selected');
  assert.equal(state.readingSize(100), 9);
  state.setReadingFont(null, 0, 0, 0, 0, 0xffffffff, 0xffffffff);
  assert.equal(
    state.readingFontName.every((value) => value === 0),
    true,
  );
});

test('text policies use the initialized profile and retain the native conditional self-assignment', () => {
  const {state} = setup();
  const fields = [
    'field1C90F0',
    'field1D1E54',
    'field1C90FC',
    'field1D27A0',
    'field1D1E40',
    'field1D27B0',
    'field1D1DB8',
    'field1D27A4',
    'field1C90E0',
    'field1D1DAC',
    'field1D1DBC',
    'field1D1D94',
  ];
  assert.deepEqual(
    fields.map((field) => state[field]),
    [1, 0, 65536, 0, 0, 0, 0, 0, 1, 0, 0, 0],
  );
  const selectors = [0, ...Array.from({length: 11}, (_, index) => 0x80000000 + index)];
  for (let index = 0; index < selectors.length; index++) {
    const value = index === 6 ? 1 : index + 10;
    assert.equal(state.setPolicy(selectors[index], value), 0);
    assert.equal(state[fields[index]], value);
  }
  const writes = [];
  let stored = state.field1D1DB8;
  Object.defineProperty(state, 'field1D1DB8', {
    get() {
      return stored;
    },
    set(value) {
      writes.push(value);
      stored = value;
    },
  });
  assert.equal(state.setPolicy(0x80000005, 9), 0);
  assert.deepEqual(writes, [1]);
});

test('animated text frames clone through the shared compositor and preserve blank entries and position status', () => {
  const {state, surfaces} = setup();
  surfaces.allocate(5, 2, 2, 2);
  surfaces.fill(5, 0xff804020);
  surfaces.allocate(6, 1, 3, 1);
  surfaces.fill(6, 0x102030);
  const error = {value: 77};
  assert.equal(state.configureOverlayFrames(3, ids(5, 0xffffffff, 6), error), 1);
  assert.equal(error.value, 77);
  assert.equal(state.overlayFrameCount, 3);
  assert.deepEqual(
    state.overlayFrames.map((frame) => [frame.width, frame.height, frame.format]),
    [
      [2, 2, 2],
      [0, 0, 0],
      [1, 3, 2],
    ],
  );
  assert.equal(state.overlayFrames[1].storage, null);
  assert.notEqual(state.overlayFrames[0].storage, surfaces.snapshot(5).storage);
  assert.equal(firstPixel(state.overlayFrames[0]) & 0xffffff, 0x804020);
  surfaces.fill(5, 0xff000000);
  assert.equal(firstPixel(state.overlayFrames[0]) & 0xffffff, 0x804020);
  assert.equal(state.setOverlayPosition(3, 7, 11), 0x80000008);
  assert.deepEqual(
    [
      state.overlayPositionMode,
      state.overlayPositionX,
      state.overlayPositionY,
      state.overlayFrameInterval,
    ],
    [3, 7, 11, 150],
  );
  state.clearOverlayFrames();
  assert.deepEqual([state.overlayFrameCount, state.overlayFrames], [0, null]);
});

test('all five reading-font, policy and frame wrappers use real stacks and the same text owner', async () => {
  const {text, fonts, surfaces, state} = setup();
  const definitions = createTextLayoutSettings(state, {
    threadFatal() {
      assert.fail('ordinary text settings should not raise a thread error');
    },
  });
  assert.deepEqual(
    definitions.map((slot) => [slot.primary, slot.secondary]),
    [
      [0x90, 0x98],
      [0x90, 0x9a],
      [0x91, 0x97],
      [0x91, 0x9a],
      [0x92, 0x97],
    ],
  );
  for (const slot of definitions)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[slot.primary][slot.secondary]);
  const thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    memory = new AokanaBpMemory(new Uint8Array(128));
  async function call(primary, secondary, args, output = false) {
    const before = thread.stackIndex;
    for (const arg of args) push32(thread, arg);
    assert.equal(
      await definitions
        .find((slot) => slot.primary === primary && slot.secondary === secondary)
        .execute({thread, memory}),
      0,
    );
    assert.equal(thread.stackIndex, before + Number(output));
    return output ? pop32(thread) : undefined;
  }
  const index = fonts.registerName(text.encodeWide('Shared', 1), 1);
  await call(0x91, 0x97, [index, 9, 80, 2, 3]);
  assert.deepEqual(
    [
      state.readingFontSize,
      state.readingWidth,
      state.readingXOffset,
      state.readingYOffset,
      state.readingValue1C90F8,
      state.readingValue1C90F4,
    ],
    [9, 80, 2, 3, 0xffffffff, 0xffffffff],
  );
  await call(0x92, 0x97, [index, 10, 75, 4, 5, 0x123456, 0xabcdef]);
  assert.deepEqual(
    [
      state.readingFontSize,
      state.readingWidth,
      state.readingXOffset,
      state.readingYOffset,
      state.readingValue1C90F8,
      state.readingValue1C90F4,
    ],
    [10, 75, 4, 5, 0x123456, 0xabcdef],
  );
  await call(0x91, 0x9a, [0x80000002, 7]);
  assert.equal(state.field1D27A0, 7);
  assert.equal(await call(0x90, 0x9a, [4, 12, 13], true), 1);
  assert.deepEqual(
    [state.overlayPositionMode, state.overlayPositionX, state.overlayPositionY],
    [4, 12, 13],
  );
  surfaces.allocate(2, 1, 1, 1);
  surfaces.fill(2, 0x987654);
  memory.globalMemory.set(ids(2, 0xffffffff).bytes, 16);
  await call(0x90, 0x98, [2, 16]);
  assert.equal(firstPixel(state.overlayFrames[0]) & 0xffffff, 0x987654);
  await call(0x90, 0x98, [0, 0]);
  assert.equal(state.overlayFrameCount, 0);
});
