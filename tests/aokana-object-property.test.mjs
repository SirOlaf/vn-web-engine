import {bitmapWrite32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {createGroup91ObjectProperty} from '../dist/engines/buriko/games/aokana/native/group-91-object-property.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaBitmapStorage} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaDisplayRenderer} from '../dist/engines/buriko/games/aokana/native/display-renderer.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AOKANA_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/games/aokana/native/inventory.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

const rectangle = (left, top, right, bottom) => ({left, top, right, bottom});
const bitmap = (width, height, values = []) => ({
  storage: new AokanaBitmapStorage(
    new Uint8Array(
      new Uint32Array(Array.from({length: width * height}, (_, index) => values[index] ?? 0))
        .buffer,
    ),
    true,
  ),
  offset: 0,
  stride: width * 4,
  width,
  height,
  format: 1,
  bytesPerPixel: 4,
});

function fixture() {
  const compositor = new AokanaBitmapCompositor();
  compositor.defaultFormat = 1;
  const bounds = rectangle(0, 0, 7, 3),
    output = bitmap(8, 4),
    environment = new AokanaDisplayObjectEnvironment(
      compositor,
      new AokanaDisplayDamage(16, {...bounds}),
    );
  environment.displayContext = {bitmap: output, bounds};
  const allocator = new AokanaDistributedAllocator(2),
    text = new AokanaNativeText(),
    surfaces = new AokanaSurfaces(new AokanaNativeFonts(text), compositor, allocator),
    manager = new AokanaDisplayManager(
      environment,
      surfaces,
      new AokanaNativeDisplayState(1920, 1080),
    );
  return {allocator, compositor, environment, manager, output, surfaces, text};
}

test('property query writes a packed caller record consumed by real Sprite rendering', () => {
  const {allocator, manager, surfaces, output, text} = fixture();
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const memory = new AokanaBpMemory(new Uint8Array(64));
  const view = new DataView(memory.globalMemory.buffer);
  const context = {thread, memory, diagnostics: {}};
  const [slot] = createGroup91ObjectProperty(manager, {
    files: {text},
    threadFatal() {
      assert.fail('ordinary property query must succeed');
    },
  });
  assert.equal(slot.secondary, 0x38);
  assert.equal(slot.nativeAddress, AOKANA_NATIVE_SLOT_ADDRESSES[0x91][0x38]);
  assert.equal(surfaces.allocate(0, 2, 1, 1), 1);
  bitmapWrite32(surfaces.snapshot(0), 0, 0x204060);
  bitmapWrite32(surfaces.snapshot(0), 4, 0x6080a0);
  const handle = manager.createSprite(),
    copyHandle = manager.createSprite();
  const sprite = manager.find('sprite', handle),
    copy = manager.find('sprite', copyHandle);
  for (const object of [sprite, copy]) {
    assert.equal(object.initializeSimple(0, 0, 0, 0, 0, 3), 0);
    object.setActivation(1);
  }
  sprite.setCoordinates(1 << 16, 1 << 16, 2 << 16);
  assert.equal(sprite.setCustom(3, 73), true);
  // A one-byte record kind precedes the native DWORD payload.
  view.setUint8(0, 7);
  const query = (selector) => {
    [1, handle, selector].forEach((value) => push32(thread, value));
    assert.equal(slot.execute(context), 0);
    assert.equal(thread.stackIndex, 0);
  };
  const values = (count) =>
    Array.from({length: count}, (_, index) => view.getInt32(1 + 4 * index, true));
  query(0x20);
  assert.deepEqual(values(3), [1 << 16, 1 << 16, 2 << 16]);
  query(0);
  assert.deepEqual(values(2), [1, 1]);
  const [x, y] = values(2);
  query(0x10000100);
  assert.deepEqual(values(4), [2, 1, 2, 1]);
  const [width] = values(4);
  copy.setPosition(x + width + 1, y, 1, 1);
  const renderer = new AokanaDisplayRenderer(
    manager,
    1024,
    new AokanaDistributedProcessing(allocator, 2),
  );
  renderer.drawFull();
  assert.deepEqual(
    Array.from({length: 8}, (_, column) =>
      output.storage.view.getUint32(output.stride + 4 * column, true),
    ),
    [0, 0x204060, 0x6080a0, 0, 0x204060, 0x6080a0, 0, 0],
  );
  view.setUint32(1, 3, true);
  query(0x7fffffff);
  assert.deepEqual(values(1), [73]);
  query(0x10);
  assert.deepEqual(values(1), [0]);
  const existingCaller = new Uint32Array(4);
  assert.equal(sprite.getProperty(0x10000100, existingCaller), 0);
  assert.deepEqual(Array.from(existingCaller), [2, 1, 2, 1]);
  assert.equal(view.getUint8(0), 7);
});
