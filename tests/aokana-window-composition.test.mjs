import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AokanaBitmapStorage,
  allocateAokanaBitmap,
} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {clearAokanaBitmap} from '../dist/engines/buriko/games/aokana/native/bitmap-copy.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaWindowDisplayState} from '../dist/engines/buriko/games/aokana/native/display-window-state.js';
import {AokanaWindowDisplayObject} from '../dist/engines/buriko/games/aokana/native/display-window.js';
import {createGroup90Windows} from '../dist/engines/buriko/games/aokana/native/group-90-windows.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';

function setup() {
  const compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 1;
  const surfaces = new AokanaSurfaces(
    new AokanaNativeFonts(new AokanaNativeText()),
    compositor,
    new AokanaDistributedAllocator(1),
  );
  const env = new AokanaDisplayObjectEnvironment(
    compositor,
    new AokanaDisplayDamage(64, {left: 0, top: 0, right: 799, bottom: 599}),
  );
  const manager = new AokanaDisplayManager(env, surfaces, new AokanaNativeDisplayState(800, 600));
  manager.bindDisplayContext({
    bitmap: allocateAokanaBitmap(800, 600, 1),
    bounds: {left: 0, top: 0, right: 799, bottom: 599},
  });
  const state = new AokanaWindowDisplayState(manager);
  const window = new AokanaWindowDisplayObject(state, 7);
  assert.equal(window.configureInitial(32, 20), 1);
  // A native background update supplies the first composed frame.
  window.setBackgroundEnabled(1);
  return {compositor, surfaces, env, manager, state, window};
}
function bitmap(width, height, pixels, format = 2) {
  return {
    storage: new AokanaBitmapStorage(new Uint8Array(Uint32Array.from(pixels).buffer), true),
    offset: 0,
    stride: width * 4,
    width,
    height,
    format,
    bytesPerPixel: 4,
  };
}
function pixel(bitmap, x, y) {
  return bitmap.storage.view.getUint32(bitmap.offset + y * bitmap.stride + x * 4, true);
}
const area = () => ({left: 0, top: 0, right: 0, bottom: 0});

test('window geometry uses native units and owns alpha composition separately from base geometry', () => {
  const {window, state} = setup();
  const small = new AokanaWindowDisplayObject(state, 9);
  assert.equal(small.configureInitial(2, 1), 1);
  small.setBackgroundEnabled(1);
  assert.deepEqual([small.bitmap.width, small.bitmap.height], [64, 32]);
  assert.deepEqual(
    [small.category, small.depthOrder, small.value120, small.blendMode],
    [3, 9, 1, 1],
  );
  assert.equal(window.bitmap.format, 1);
  assert.equal(window.bitmap.storage, null);
  assert.equal(window.compositionBitmap.format, 2);
  assert.equal(window.backgroundBitmap.format, 2);
  assert.equal(window.textBitmap.format, 2);
  assert.notEqual(window.compositionBitmap.storage, window.textBitmap.storage);
  assert.deepEqual(window.getTextRectangle(), {left: 0, top: 0, right: 31, bottom: 19});
  assert.deepEqual(window.getTextCursor(), {x: 0, y: 0});
  small.configureInnerObjects(3);
  assert.equal(small.inner.renderer.manager, small.inner);
  assert.equal(small.inner.context.bitmap.storage, small.compositionBitmap.storage);
  assert.notEqual(small.inner.damage, state.manager.damage);
  assert.equal(small.inner.renderer.processing.capacity, 1);
  assert.deepEqual(small.innerOrigin, {x: -400, y: -300});
  assert.equal(small.innerProjection, 400);
  small.dispose();
});

test('window text and overlays compose in order, with old overlay regions refreshed when moved', () => {
  const {window, surfaces} = setup();
  surfaces.allocate(0, 32, 20, 1);
  surfaces.fill(0, 0x112233);
  assert.equal(window.setBackgroundSurface(0), 0);
  window.setTextEnabled(1);
  const red = bitmap(2, 1, [0xffcc0000, 0xffcc0000]),
    out = area();
  assert.equal(window.drawTextBitmap(out, 2, 1, red, 0x80, 0), 0);
  assert.equal(pixel(window.compositionBitmap, 2, 1), 0xffcc0000);
  const green = bitmap(1, 1, [0xff00bb00]);
  assert.equal(window.setOverlayBitmap(0, green), 0);
  window.setOverlayPosition(0, 3, 1, 0);
  window.setOverlayEnabled(0, 1);
  assert.equal(pixel(window.compositionBitmap, 3, 1), 0xff00bb00);
  window.setOverlayPosition(0, 4, 1, 0);
  assert.equal(pixel(window.compositionBitmap, 3, 1), 0xffcc0000);
  assert.equal(pixel(window.compositionBitmap, 4, 1), 0xff00bb00);
  window.move(100, 200);
  window.setOffset(5, 7);
  assert.deepEqual(window.overlayRectangle(0), {left: 109, top: 208, right: 109, bottom: 208});
  window.setCompositionOrder(2);
  window.composeAll();
  assert.equal(pixel(window.compositionBitmap, 4, 1), 0xff112233);
  window.setCompositionOrder(0);
  window.composeAll();
  window.disableOverlays();
  assert.equal(pixel(window.compositionBitmap, 4, 1), 0xff112233);
});

test('window text clipping, row scroll, cursor direction and saved text follow the selected region', () => {
  const {window} = setup();
  window.setTextEnabled(1);
  window.move(10, 20);
  assert.equal(window.setTextRectangle({left: 1, top: 1, right: 3, bottom: 3}), 1);
  assert.deepEqual(window.getTextCursor(), {x: 1, y: 1});
  window.setWritingDirection(1);
  assert.deepEqual(window.getTextCursor(), {x: 3, y: 1});
  window.advanceTextCursor(2);
  assert.deepEqual(window.getTextCursor(), {x: 3, y: 3});
  assert.equal(window.textAdvanceFits(1), 1);
  window.setWritingDirection(0);
  const values = Array.from({length: 16}, (_, i) => (0xff000000 + i + 1) >>> 0),
    out = area();
  assert.equal(window.drawTextBitmap(out, 0, 0, bitmap(4, 4, values), 0x80, 0), 0);
  assert.deepEqual(out, {left: 11, top: 21, right: 13, bottom: 23});
  assert.equal(pixel(window.textBitmap, 0, 0), 0);
  assert.equal(pixel(window.textBitmap, 1, 1), values[5]);
  assert.equal(window.scrollText(1), true);
  assert.equal(pixel(window.textBitmap, 1, 1), values[9]);
  assert.equal(pixel(window.textBitmap, 1, 2), values[13]);
  assert.equal(pixel(window.textBitmap, 1, 3), 0);
  window.saveText();
  window.clearText();
  assert.equal(window.restoreText(), 0);
  assert.equal(pixel(window.textBitmap, 1, 1), values[9]);
  assert.equal(pixel(window.compositionBitmap, 1, 1), 0);
  window.composeAll();
  // This pixel is paired with transparent x=0, so the pair kernel uses 255/256.
  assert.equal(pixel(window.compositionBitmap, 1, 1), 0xff000009);
});

test('text-mask mode erases overlay coverage before text composition even for fully faded overlays', () => {
  const {window} = setup();
  window.setTextEnabled(1);
  const out = area();
  window.drawTextBitmap(out, 1, 1, bitmap(2, 1, [0xffc04020, 0xffc04020]), 0x80, 0);
  window.setOverlayBitmap(0, bitmap(1, 1, [0x01020304]));
  window.setOverlayPosition(0, 1, 1, 256);
  window.setOverlayEnabled(0, 1);
  assert.equal(pixel(window.compositionBitmap, 1, 1), 0xffc04020);
  window.setTextMaskMode(1);
  assert.equal(pixel(window.compositionBitmap, 1, 1), 0xff000000);
  assert.equal(pixel(window.compositionBitmap, 2, 1), 0xffc04020);
});

test('shared window globals update before pool invalidation and combine the two fades when drawing', () => {
  const {state, manager, window} = setup(),
    events = [];
  class RecordedWindow extends AokanaWindowDisplayObject {
    invalidate() {
      events.push([this.handle, state.enabled, state.transparency]);
      super.invalidate();
    }
  }
  const first = manager.createConfigured(
    'window',
    (order) => new RecordedWindow(state, order),
    (object) => object.configureInitial(32, 20),
  );
  const second = manager.createConfigured(
    'window',
    (order) => new RecordedWindow(state, order),
    (object) => object.configureInitial(32, 20),
  );
  state.set(1, 128);
  assert.deepEqual(events, [
    [first.handle, 1, 128],
    [second.handle, 1, 128],
  ]);
  window.fillBackground(0xff804020);
  window.blendValue = 128;
  const destination = bitmap(1, 1, [0], 1);
  window.draw(destination, {left: 0, top: 0, right: 0, bottom: 0}, 0);
  // Combined transparency is 192; native alpha/2 truncates 127*64/256 to 31.
  assert.equal(pixel(destination, 0, 0), 0x1f0f07);
  state.set(0, 0);
  clearAokanaBitmap(destination);
  window.draw(destination, {left: 0, top: 0, right: 0, bottom: 0}, 0);
  assert.equal(pixel(destination, 0, 0), 0);
});

test('all nine window wrappers preserve native stack order and use the shared pool and surfaces', async () => {
  const {state, manager, surfaces} = setup();
  const slots = createGroup90Windows(state, {
    threadFatal() {
      assert.fail('ordinary window operations should not raise a thread error');
    },
    files: {text: new AokanaNativeText()},
  });
  assert.deepEqual(
    slots.map((slot) => slot.secondary),
    [0x80, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89],
  );
  for (const slot of slots)
    assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x90][slot.secondary]);
  const thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 32,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    memory = new AokanaBpMemory(new Uint8Array(128));
  async function call(secondary, args, output = false) {
    const before = thread.stackIndex;
    for (const arg of args) push32(thread, arg);
    assert.equal(
      await slots.find((slot) => slot.secondary === secondary).execute({thread, memory}),
      0,
    );
    assert.equal(thread.stackIndex, before + Number(output));
    return output ? pop32(thread) : undefined;
  }
  const handle = await call(0x80, [32, 20], true),
    object = manager.find('window', handle);
  assert.equal(handle, 0xb0000000);
  assert.ok(object instanceof AokanaWindowDisplayObject);
  assert.equal(manager.categoryCount(5), 1);
  surfaces.allocate(0, 32, 20, 1);
  surfaces.fill(0, 0x224466);
  await call(0x86, [handle, 123, 124, 0]);
  await call(0x84, [handle, 1]);
  await call(0x85, [handle, 11, 13, 1, 64, 200, 3]);
  assert.deepEqual(object.position(), {x: 11, y: 13});
  assert.deepEqual(
    [object.blendMode, object.blendValue, object.transparency, object.layer],
    [1, 64, 0, 3],
  );
  await call(0x82, [handle, 1]);
  await call(0x87, [handle, 1]);
  await call(0x88, [handle, 1, 2, 4, 5]);
  assert.equal(await call(0x89, [16, handle], true), 1);
  assert.deepEqual(Array.from(new Int32Array(memory.globalMemory.buffer, 16, 4)), [1, 2, 4, 6]);
  await call(0x83, [5, handle]);
  assert.equal(surfaces.descriptor(5).format, 2);
  assert.equal(pixel(surfaces.descriptor(5), 0, 0), 0xff224466);
  assert.notEqual(surfaces.descriptor(5).storage, object.compositionBitmap.storage);
});
