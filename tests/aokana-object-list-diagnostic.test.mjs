import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaNativeInput} from '../dist/engines/buriko/games/aokana/native/input.js';
import {AokanaNativeCursor} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {createGroupE0ObjectList} from '../dist/engines/buriko/games/aokana/native/group-e0-object-list.js';
import {AokanaEngineDialogs} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {AokanaSelectionDialog} from '../dist/engines/buriko/games/aokana/native/selection-dialog.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpThread} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaBitmapStorage} from '../dist/engines/buriko/games/aokana/native/bitmap.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
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

test('ordinary object list uses real layer ordering and the shared native selection dialog', async () => {
  const {manager, surfaces, text} = fixture();
  assert.equal(surfaces.allocate(0, 2, 1, 1), 1);
  surfaces.fill(0, 0x204060);
  const first = manager.createSprite(),
    second = manager.createSprite();
  assert.equal(manager.initializeSimpleSprite(first, 0, 0, 0, 0, 0, 2), 0);
  assert.equal(manager.initializeSimpleSprite(second, 2, 0, 0, 0, 0, 3), 0);
  manager.resolve(first).setActivation(1);
  manager.resolve(second).setActivation(0);
  manager.setRenderPixelBudget(1024);
  manager.initializeObjectRenderer();
  const clock = new AokanaNativeClock(() => 100),
    input = new AokanaNativeInput(manager.displayState, clock);
  const cursor = new AokanaNativeCursor({style: {cursor: ''}});
  cursor.setVisible(0);
  const events = [];
  const dialogs = new AokanaEngineDialogs(
    {
      chooseFont: async (message) => {
        assert.equal(cursor.requestedVisibility, 1);
        assert.equal(manager.displayState.modalDepth, 1);
        events.push(message);
        return {accepted: true, index: 2};
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
  const selection = new AokanaSelectionDialog(dialogs, text);
  const caption = new TextEncoder().encode('Engine\0');
  const [slot] = createGroupE0ObjectList(manager, selection, caption);
  assert.deepEqual(
    [slot.primary, slot.secondary, slot.nativeAddress],
    [0xe0, 0, AOKANA_NATIVE_SLOT_ADDRESSES[0xe0][0]],
  );
  const thread = new AokanaBpThread({
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
      prompt: '表示オブジェクト一覧',
      faces: ['BG - $00000000( 0 )', 'Sprite - $00000002( 2 )', 'Sprite - $00000003( 3 )'],
    },
  ]);
  assert.equal(cursor.requestedVisibility, 0);
  assert.equal(manager.displayState.modalDepth, 0);
});
