import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoDisplayFrames} from '../dist/engines/buriko/native/display-frames.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {BurikoDisplayObjectEnvironment} from '../dist/engines/buriko/native/display-object.js';
import {BurikoDisplayRenderer} from '../dist/engines/buriko/native/display-renderer.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoDisplayTexture} from '../dist/engines/buriko/native/display-texture.js';
import {BurikoWindowDisplayState} from '../dist/engines/buriko/native/display-window-state.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {createGroup90DisplayBase} from '../dist/engines/buriko/native/group-90-display-base.js';
import {BURIKO_NATIVE_SLOT_ADDRESSES} from '../dist/engines/buriko/native/inventory.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoProgramResources} from '../dist/engines/buriko/native/program-resources.js';
import {BurikoResourceLoadingState} from '../dist/engines/buriko/native/resource-loading.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {SourceFileSystem} from '../dist/platform/filesystem.js';
import {WindowsFileSystem, windowsFileKey} from '../dist/platform/windows-filesystem.js';

const pixels = (bitmap) =>
  Array.from({length: bitmap.width * bitmap.height}, (_, index) =>
    bitmap.storage.view.getUint32(index * 4, true),
  );

function fixture() {
  const text = new BurikoNativeText(),
    fonts = new BurikoNativeFonts(text),
    compositor = new BurikoBitmapCompositor(),
    allocator = new BurikoDistributedAllocator(1),
    surfaces = new BurikoSurfaces(fonts, compositor, allocator),
    damage = new BurikoDisplayDamage(16, {left: 0, top: 0, right: 1, bottom: 1}),
    environment = new BurikoDisplayObjectEnvironment(compositor, damage),
    displayState = new BurikoNativeDisplayState(1920, 1080),
    manager = new BurikoDisplayManager(environment, surfaces, displayState),
    renderer = new BurikoDisplayRenderer(manager, 4),
    texture = new BurikoDisplayTexture(2, 2, 22),
    windows = new BurikoWindowDisplayState(manager),
    frames = new BurikoDisplayFrames(manager, null, null, null, null, null, null, null, null),
    media = new BurikoProgramMedia(),
    files = new BurikoProgramFiles(
      new WindowsFileSystem(new SourceFileSystem(windowsFileKey), {
        cwd: 'C:\\game',
        mounts: [{windows: 'C:\\', virtual: '/'}],
      }),
      text,
      media,
    ),
    fatal = () => assert.fail('ordinary display-base operations should succeed'),
    bytes = (value) => new TextEncoder().encode(value),
    resources = new BurikoProgramResources(
      files,
      {
        nativeFileRoot: 'C:\\game\\',
        primaryRoot: bytes('C:\\game\\'),
        secondaryRoot: bytes('C:\\disc\\'),
        secondaryMediaPath: 'C:\\disc\\',
        searchDirectoriesEnabled: 0,
        searchDirectories: [],
        retryTitle: bytes('Media'),
        retryMessage: bytes('Insert'),
        quitConfirmation: bytes('Quit?'),
      },
      {show: fatal},
      {fatal, threadFatal: fatal},
      new BurikoDistributedProcessing(allocator, 1),
    ),
    loading = new BurikoResourceLoadingState(resources),
    slots = createGroup90DisplayBase(manager, frames, loading, windows, {
      files: {text: {encodeWide: (message) => message}},
      threadFatal() {
        assert.fail('ordinary display-base operations should succeed');
      },
    }),
    thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 32,
      moduleCapacity: 0,
      frameCapacity: 0,
    }),
    context = {
      thread,
      memory: new BurikoBpMemory(new Uint8Array(0)),
      diagnostics: {},
    };
  manager.configureDescriptor(2, 2, 2, 4);
  manager.setDisplayTexture(texture);
  const call = (secondary, args) => {
    const before = thread.stackIndex;
    args.forEach((value) => push32(thread, value));
    const result = slots.find((slot) => slot.secondary === secondary).execute(context);
    assert.equal(result, 0);
    assert.equal(thread.stackIndex, before);
  };
  return {
    call,
    compositor,
    damage,
    displayState,
    fonts,
    loading,
    manager,
    renderer,
    slots,
    surfaces,
    texture,
    windows,
  };
}

test('thirteen Bank90 base wrappers preserve native pop order and mutate their shared owners', () => {
  const s = fixture();
  assert.equal(s.slots.length, 13);
  for (const slot of s.slots)
    assert.equal(slot.nativeAddress, BURIKO_NATIVE_SLOT_ADDRESSES[0x90][slot.secondary]);

  s.call(0x00, [0]);
  assert.deepEqual([s.manager.redraw.pending, s.manager.redraw.mode], [1, 0]);
  s.call(0x00, [9]);
  assert.deepEqual([s.manager.redraw.pending, s.manager.redraw.mode], [1, 1]);
  s.call(0x01, [7]);
  assert.equal(s.displayState.presentationEnabled, 7);
  s.call(0x02, [25]);
  assert.deepEqual([s.displayState.frameInterval, s.displayState.frameDeadline], [40, 0]);
  s.call(0x03, [4096]);
  assert.equal(s.loading.cache.capacity, 4096);

  s.damage.clear();
  s.call(0x06, [13, 17]);
  assert.deepEqual(s.manager.referencePoint, {x: 13, y: 17});
  assert.equal(s.damage.fullRedraw, 1);
  s.damage.clear();
  s.call(0x08, [0x12345678]);
  assert.equal(s.damage.fullRedraw, 1);
  s.call(0x09, [27]);
  assert.equal(s.manager.minimumKey, 27 << 16);
  s.call(0x0a, [5, 6]);
  assert.deepEqual([s.manager.redraw.automaticEnabled, s.manager.redraw.automaticMode], [5, 6]);
  s.call(0x0c, [3, 192]);
  assert.deepEqual([s.windows.enabled, s.windows.transparency], [3, 192]);

  const font = Uint8Array.of(84, 101, 115, 116, 0),
    fontNumber = s.fonts.registerName(font, 0);
  s.call(0x0e, [fontNumber, 24, 100, 1, 48]);
  const registeredFont = s.fonts.name(fontNumber);
  assert.notEqual(registeredFont, null);
  assert.equal(s.fonts.cacheCapacity(registeredFont, 24, 100, 1), 48);
  s.call(0x0f, [0x123456]);
  assert.equal(s.compositor.importMatteColor, 0x123456);
});

test('display capture and priority rendering use the mapped texture, surface table, and object renderer', () => {
  const s = fixture(),
    captured = [0x10203040, 0x50607080, 0x90a0b0c0, 0xd0e0f000];
  captured.forEach((value, index) => s.texture.storage.view.setUint32(index * 4, value, true));
  s.texture.storage.written(0, s.texture.storage.bytes.length);
  s.call(0x04, [4]);
  assert.deepEqual(pixels(s.surfaces.descriptor(4)), captured);

  assert.equal(s.surfaces.allocate(5, 2, 2, 2), 1);
  const source = s.surfaces.descriptor(5),
    rendered = [0xff102030, 0xff405060, 0xff708090, 0xffa0b0c0];
  rendered.forEach((value, index) => source.storage.view.setUint32(index * 4, value, true));
  source.storage.written(0, source.storage.bytes.length);
  assert.equal(s.manager.backdrop.setSurface(5), 1);
  s.manager.backdrop.setContentEnabled(1);
  s.call(0x05, [6, 0]);
  assert.deepEqual(pixels(s.surfaces.descriptor(6)), rendered);
});
