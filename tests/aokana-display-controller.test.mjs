import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoDisplayController} from '../dist/engines/buriko/native/display-controller.js';
import {BurikoDisplayAdapters} from '../dist/engines/buriko/native/display-adapters.js';
import {BurikoDisplayDevice} from '../dist/engines/buriko/native/display-device.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {BurikoDisplayObjectEnvironment} from '../dist/engines/buriko/native/display-object.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoSystemTicks} from '../dist/engines/buriko/native/system-ticks.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BurikoWindowMessages} from '../dist/engines/buriko/native/window-messages.js';
import {BurikoKeyboardMessages} from '../dist/engines/buriko/native/keyboard-messages.js';
import {BurikoBrowserMainWindow} from '../dist/engines/buriko/native/browser-main-window.js';
import {BurikoNativeRegistry} from '../dist/engines/buriko/native/windows-registry.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {
  BurikoEngineDialogs,
  BurikoNativeCursor,
} from '../dist/engines/buriko/native/engine-dialogs.js';
import {BurikoDisplayMouseTrails} from '../dist/engines/buriko/native/display-mouse-trails.js';
import {BurikoLocalizedMessages} from '../dist/engines/buriko/native/localized-messages.js';
import {BurikoNativeLanguage} from '../dist/engines/buriko/native/group-81-language.js';
import {BurikoInlineTextControl} from '../dist/engines/buriko/native/inline-text-control.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoFullscreenMovieState} from '../dist/engines/buriko/native/movie-fullscreen-state.js';
import {BurikoNativeNotifications} from '../dist/engines/buriko/native/notification-queue.js';
import {BurikoCpuProfile} from '../dist/engines/buriko/native/cpu-profile.js';
import {BurikoImportedTextMaps} from '../dist/engines/buriko/native/imported-text-maps.js';
import {BurikoWindowDisplayState} from '../dist/engines/buriko/native/display-window-state.js';
import {BurikoWindowDisplayObject} from '../dist/engines/buriko/native/display-window.js';
import {setBurikoRequestedClientSize} from '../dist/engines/buriko/native/display-services.js';

// Ordinary configured CPUID primitives; no native program or hardware probe is executed.
function cpuProfile() {
  let tick = 0,
    timestamp = 0n;
  const cpu = new BurikoCpuProfile(
    {
      cpuid(leaf) {
        if (leaf === 0) return [1, 0x68747541, 0x444d4163, 0x69746e65];
        if (leaf === 1) return [0x600, 0, 0, 1 << 26];
        if (leaf === 0x80000000) return [0x80000006, 0, 0, 0];
        if (leaf === 0x80000005) return [0, 0, 0x40080040, 0];
        return [0, 0, 0, 0];
      },
      readTimestampCounter: () => (timestamp += 1000000000n),
      setCurrentThreadAffinity: () => 1n,
      logicalProcessorCount: () => 1,
      logicalProcessorInformation: () => [{relationship: 0, processorMask: 1n}],
    },
    new BurikoNativeClock(() => (tick += 125)),
  );
  assert.equal(cpu.initialize(), true);
  return cpu;
}

function fixture() {
  let tick = 100;
  const calls = [],
    context = {
      createImageData: (width, height) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      }),
      save() {},
      restore() {},
      resetTransform() {},
      fillRect: (...rectangle) => calls.push(['clear', ...rectangle]),
    },
    document = {defaultView: {}, activeElement: null},
    parent = {
      style: {},
      children: [],
      append(child) {
        this.children.push(child);
      },
      setAttribute(name, value) {
        this[name] = value;
      },
    },
    canvas = {
      width: 0,
      height: 0,
      style: {},
      ownerDocument: document,
      addEventListener() {},
      removeEventListener() {},
      getContext: () => context,
      focus() {
        document.activeElement = this;
        calls.push(['focus']);
      },
    };
  const display = new BurikoNativeDisplayState(16, 8);
  display.setSizePreset(2, 4, 2);
  display.requestedWidth = 8;
  display.requestedHeight = 4;
  display.frameInsetWidth = display.frameInsetHeight = 2;
  display.windowClientOrigin[1] = -1;
  display.monitors = [[0, 0, 16, 8]];
  const clock = new BurikoNativeClock(() => tick),
    ticks = new BurikoSystemTicks({now: () => tick}),
    input = new BurikoNativeInput(display, clock),
    messages = new BurikoWindowMessages(input),
    compositor = new BurikoBitmapCompositor(),
    allocator = new BurikoDistributedAllocator(1),
    environment = new BurikoDisplayObjectEnvironment(
      compositor,
      new BurikoDisplayDamage(64, {left: 0, top: 0, right: 3, bottom: 1}),
    ),
    text = new BurikoNativeText(),
    manager = new BurikoDisplayManager(
      environment,
      new BurikoSurfaces(new BurikoNativeFonts(text), compositor, allocator),
      display,
    ),
    mode = {width: 16, height: 8, refreshRate: 60, format: 22},
    adapters = new BurikoDisplayAdapters(
      display,
      [{monitor: 0, pixelShaderVersion: 0xffff0300, mode}],
      0,
      () => [
        display.windowX,
        display.windowY,
        display.windowX + (parseInt(parent.style.width) || 10),
        display.windowY + (parseInt(parent.style.height) || 6),
      ],
    ),
    device = new BurikoDisplayDevice(canvas, manager, clock, adapters),
    dialogs = new BurikoEngineDialogs(
      {},
      text,
      clock,
      input,
      new BurikoNativeCursor(canvas),
      device,
      display,
      null,
      new Uint8Array([0]),
    ),
    host = new BurikoBrowserMainWindow(document, parent, canvas, manager, {
      isReady: () => true,
      presentTransient: () => 0,
      inlinePaintSuppressed: () => false,
      geometryChanged: (value) => controller.noteGeometryChange(value),
    }),
    trails = new BurikoDisplayMouseTrails(new BurikoNativeRegistry(new MemoryStore()), dialogs),
    localized = new BurikoLocalizedMessages(
      text,
      new BurikoNativeLanguage(() => 0x409),
      new BurikoImportedTextMaps(text),
    ),
    inline = new BurikoInlineTextControl(
      host,
      new BurikoNativeFonts(text),
      dialogs,
      messages,
      new BurikoKeyboardMessages(messages),
    ),
    fullscreenMovie = new BurikoFullscreenMovieState(),
    notifications = new BurikoNativeNotifications(),
    controller = new BurikoDisplayController(
      manager,
      device,
      adapters,
      host,
      cpuProfile(),
      ticks,
      trails,
      localized,
      messages,
      fullscreenMovie,
      inline,
      notifications,
    );
  messages.createMainTarget();
  return {
    controller,
    display,
    manager,
    device,
    adapters,
    mode,
    input,
    messages,
    canvas,
    parent,
    notifications,
    calls,
    setTick: (value) => {
      tick = value;
    },
  };
}

test('display mode transitions preserve concrete windows and rebase their inner sprites with the logical descriptor', async () => {
  const s = fixture();
  assert.equal(await s.controller.reconfigure(2, 1, 0, null, 1), 1);
  assert.equal(s.parent.style.width, '10px');
  assert.equal(s.canvas.width, 8);
  assert.equal(s.manager.renderPixelBudget, 6406);
  assert.equal(s.manager.lockDisplay(), 1);
  s.manager.unlockDisplay();
  assert.deepEqual(s.display.pendingWindowPosition, [3, 1]);
  assert.equal(s.display.windowPositionPending, 1);
  assert.equal(s.display.resizeInProgress, 0);
  const windows = new BurikoWindowDisplayState(s.manager);
  const createWindow = () => {
    const result = s.manager.createConfigured(
      'window',
      (order) => new BurikoWindowDisplayObject(windows, order),
      (window) => window.configureInitial(32, 20),
    );
    assert.equal(result.result, 0);
    return s.manager.find('window', result.handle);
  };
  createWindow(); // A window without an inner manager follows the same descriptor traversal.
  const window = createWindow();
  window.configureInnerObjects(2);
  s.manager.surfaces.allocate(0, 2, 2, 1);
  s.manager.surfaces.fill(0, 0x112233);
  assert.equal(window.createInnerSprite(0, 0, 1, 1, 0, 0, 0), 0);
  window.setInnerCoordinates(0, 1, 1, 1);
  const sprite = window.innerObjects[0],
    coordinates = sprite.coordinates(),
    composition = window.compositionBitmap,
    text = window.textBitmap;
  text.storage.view.setUint32(text.offset, 0xff123456, true);
  window.setTextCursor(3, 4);
  assert.equal(await s.controller.reconfigure(2, 1, 1, null, 0), 1);
  assert.equal(s.parent.style.width, '16px');
  assert.equal(s.canvas.width, 16);
  assert.equal(s.display.requestedWidth, 8);
  assert.equal(s.display.fullscreen, 1);
  assert.equal(await s.controller.reconfigure(2, 1, 0, [2, 3], 0), 1);
  assert.equal(s.display.fullscreen, 0);
  assert.deepEqual([s.display.windowX, s.display.windowY], [2, 3]);
  assert.equal(s.canvas.width, 8);
  assert.equal(s.display.resizeInProgress, 0);
  assert.deepEqual(
    s.calls.filter(([call]) => call === 'focus'),
    [['focus'], ['focus']],
  );
  await setBurikoRequestedClientSize(s.controller, 12, 6, null);
  assert.equal(s.canvas.width, 12);
  assert.deepEqual(sprite.coordinates(), coordinates);
  s.display.setSizePreset(2, 6, 4);
  await s.controller.reconfigure(2, 1, 0, null, 0);
  assert.deepEqual(sprite.coordinates(), {
    x: coordinates.x - 0x10000,
    y: coordinates.y - 0x10000,
    z: coordinates.z,
  });
  assert.equal(sprite.perspective, 3);
  assert.deepEqual(window.compositionBitmap, composition);
  assert.equal(window.textBitmap.storage, text.storage);
  assert.equal(text.storage.view.getUint32(text.offset, true), 0xff123456);
  assert.deepEqual(window.getTextCursor(), {x: 3, y: 4});
  assert.equal(s.display.resizeInProgress, 0);
});

test('deferred mode toggle appends its actual result and adapter changes refresh the cached desktop', async () => {
  const s = fixture();
  await s.controller.initialize();
  s.input.foreground = true;
  s.controller.configureModeToggle(1, null);
  s.controller.requestModeToggle();
  await s.controller.poll();
  assert.equal(s.display.fullscreen, 1);
  assert.deepEqual(s.notifications.take(), {type: 1, value1: 1, value2: 0});
  assert.equal(s.display.modeChangePending, 0);
  s.mode.width = 20;
  assert.equal(s.display.desktopWidth, 16);
  s.display.deviceChangePending = 1;
  s.display.deviceChangeDeadline = 100;
  await s.controller.poll();
  assert.equal(s.display.desktopWidth, 20);
  assert.equal(s.canvas.width, 20);
  assert.equal(s.display.delayedRedrawDeadline, 117);
  s.manager.redraw.pending = 0;
  s.setTick(117);
  await s.controller.poll();
  assert.equal(s.display.delayedRedrawDeadline, 0);
  assert.equal(s.manager.redraw.pending, 1);
});

test('capability startup caches primary metadata before shared mode creation and retains its shader gate', async () => {
  const s = fixture();
  const identifier = new Uint8Array(0x450);
  identifier.set(new TextEncoder().encode('Configured software device\0'), 0x200);
  s.adapters.records[0].identifier = identifier;
  s.display.monitors.push([16, 0, 36, 8]);
  s.adapters.records.push({
    monitor: 1,
    pixelShaderVersion: 0xffff0200,
    mode: {width: 20, height: 8, refreshRate: 75, format: 22},
  });
  s.display.windowX = 20;
  assert.equal(s.device.adapter.pixelShaderVersion, 0);
  assert.equal(await s.controller.initialize(), 1);
  assert.equal(s.controller.capabilities.isPresent(), true);
  assert.deepEqual(s.display.adapterIdentifier, identifier);
  assert.equal(s.display.pixelShaderVersion, 0xffff0300);
  assert.equal(s.device.adapter.pixelShaderVersion, 0xffff0300);
  assert.equal(s.display.physicalRasterStatus, 0);
  assert.equal(s.device.rasterStatusAvailable, false);
  assert.equal(s.device.setFilter(1), 1);
  assert.equal(s.display.selectedSizePreset, 2);
  assert.equal(s.display.selectedWindowParameter, 1);
  assert.equal(s.manager.renderPixelBudget, 6406);
  assert.equal(s.manager.lockDisplay(), 1);
  s.manager.unlockDisplay();
  assert.equal(s.display.desktopWidth, 20); // Creation subsequently queries the selected monitor.
});

test('immediate window geometry with explicit position preserves the cached monitor origin', async () => {
  const s = fixture();
  s.display.windowMoveImmediate = 1;
  s.display.desktopOrigin[0] = 71;
  s.display.desktopOrigin[1] = 83;
  await s.controller.reconfigure(2, 1, 0, [2, 3], 1);
  assert.deepEqual(s.display.desktopOrigin, [71, 83]);
  assert.deepEqual([s.display.windowX, s.display.windowY], [2, 3]);
});

test('configured monitor queries use shared bounds and keep cache reads distinct from current adapter data', () => {
  const display = new BurikoNativeDisplayState(100, 100);
  display.monitors = [
    [0, 0, 100, 100],
    [100, 0, 220, 100],
  ];
  let rectangle = [80, 10, 140, 70];
  const records = [
    {
      monitor: 0,
      pixelShaderVersion: 0xffff0300,
      mode: {width: 100, height: 100, refreshRate: 60, format: 22},
    },
    {
      monitor: 1,
      pixelShaderVersion: 0xffff0300,
      mode: {width: 120, height: 100, refreshRate: 75, format: 22},
    },
  ];
  const adapters = new BurikoDisplayAdapters(display, records, 0, () => rectangle);
  assert.equal(adapters.selectedAdapter(), 1);
  adapters.queryDesktopMode();
  assert.deepEqual([display.desktopWidth, adapters.refreshRate], [120, 75]);
  assert.deepEqual(adapters.readMonitorOrigin(), [100, 0]);
  rectangle = [250, 20, 280, 80];
  assert.equal(adapters.currentMonitor(), 0);
  display.geometryChanged = 1;
  assert.equal(adapters.currentMonitor(), 1);
  display.displayFlag = 0;
  assert.equal(adapters.selectedAdapter(), 0);
});
