import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BurikoNativeCursor} from '../dist/engines/buriko/native/engine-dialogs.js';
import {createGroupE0InputCaptures} from '../dist/engines/buriko/native/group-e0-input-captures.js';
import {BurikoEngineDialogs} from '../dist/engines/buriko/native/engine-dialogs.js';
import {BurikoSelectionDialog} from '../dist/engines/buriko/native/selection-dialog.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpThread} from '../dist/engines/buriko/bp/state.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoBitmapStorage} from '../dist/engines/buriko/native/bitmap.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {BurikoDisplayObjectEnvironment} from '../dist/engines/buriko/native/display-object.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

const rectangle = (left, top, right, bottom) => ({left, top, right, bottom});
const bitmap = (width, height, values = []) => ({
  storage: new BurikoBitmapStorage(
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
  const compositor = new BurikoBitmapCompositor();
  compositor.defaultFormat = 1;
  const bounds = rectangle(0, 0, 7, 3),
    output = bitmap(8, 4),
    environment = new BurikoDisplayObjectEnvironment(
      compositor,
      new BurikoDisplayDamage(16, {...bounds}),
    );
  environment.displayContext = {bitmap: output, bounds};
  const allocator = new BurikoDistributedAllocator(2),
    text = new BurikoNativeText(),
    surfaces = new BurikoSurfaces(new BurikoNativeFonts(text), compositor, allocator),
    manager = new BurikoDisplayManager(
      environment,
      surfaces,
      new BurikoNativeDisplayState(1920, 1080),
    );
  return {allocator, compositor, environment, manager, output, surfaces, text};
}

test('input capture list merges actual capture owners through the native selection dialog', async () => {
  const {manager, surfaces, text} = fixture();
  assert.equal(surfaces.allocate(0, 3, 2, 1), 1);
  surfaces.fill(0, 0x204060);
  const handle = manager.createSprite();
  assert.equal(manager.initializeSimpleSprite(handle, 2, 3, 0, 0, 0, 2), 0);
  const sprite = manager.resolve(handle);
  sprite.setActivation(0);
  const clock = new BurikoNativeClock(() => 100),
    input = new BurikoNativeInput(manager.displayState, clock);
  input.resetCaptures();
  input.installObjectCapture(5, [0, 0, 0, 0], sprite);
  input.installKeyCapture(5);
  input.installKeyCapture(7);
  const cursor = new BurikoNativeCursor({style: {cursor: ''}});
  cursor.setVisible(0);
  const events = [];
  const dialogs = new BurikoEngineDialogs(
    {
      chooseFont: async (message) => {
        assert.equal(cursor.requestedVisibility, 1);
        assert.equal(manager.displayState.modalDepth, 1);
        events.push(message);
        return {accepted: true, index: 1};
      },
    },
    text,
    clock,
    input,
    cursor,
    {isPresent: () => true, refresh: () => {}},
    manager.displayState,
    null,
    new TextEncoder().encode('Fallback\0'),
  );
  const selection = new BurikoSelectionDialog(dialogs, text);
  const caption = new TextEncoder().encode('Engine\0');
  const [slot] = createGroupE0InputCaptures(input, selection, caption);
  assert.deepEqual(
    [slot.primary, slot.secondary, slot.nativeAddress],
    [0xe0, 0x40, BURIKO_NATIVE_SLOT_ADDRESSES[0xe0][0x40]],
  );
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 8,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  assert.equal(await slot.execute({thread}), 0);
  assert.equal(thread.stackIndex, 0);
  assert.deepEqual(events, [
    {
      title: 'Engine',
      prompt: '入力フォーカス一覧',
      faces: ['$00000007', '$00000005 : Sprite [ 2, 3 - 4, 4 (2x1) ] <無効> ', '$00000001'],
    },
  ]);
  assert.equal(cursor.requestedVisibility, 0);
  assert.equal(manager.displayState.modalDepth, 0);
});
