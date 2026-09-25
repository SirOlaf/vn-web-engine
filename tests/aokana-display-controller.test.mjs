import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaDisplayController} from '../dist/engines/buriko/games/aokana/native/display-controller.js';
import {AokanaDisplayAdapters} from '../dist/engines/buriko/games/aokana/native/display-adapters.js';
import {AokanaDisplayDevice} from '../dist/engines/buriko/games/aokana/native/display-device.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaSystemTicks} from '../dist/engines/buriko/games/aokana/native/system-ticks.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeInput} from '../dist/engines/buriko/games/aokana/native/input.js';
import {AokanaWindowMessages} from '../dist/engines/buriko/games/aokana/native/window-messages.js';
import {AokanaKeyboardMessages} from '../dist/engines/buriko/games/aokana/native/keyboard-messages.js';
import {AokanaBrowserMainWindow} from '../dist/engines/buriko/games/aokana/native/browser-main-window.js';
import {AokanaNativeRegistry} from '../dist/engines/buriko/games/aokana/native/windows-registry.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaEngineDialogs, AokanaNativeCursor} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {AokanaDisplayMouseTrails} from '../dist/engines/buriko/games/aokana/native/display-mouse-trails.js';
import {AokanaLocalizedMessages} from '../dist/engines/buriko/games/aokana/native/localized-messages.js';
import {AokanaNativeLanguage} from '../dist/engines/buriko/games/aokana/native/group-81-language.js';
import {AokanaInlineTextControl} from '../dist/engines/buriko/games/aokana/native/inline-text-control.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaFullscreenMovieState} from '../dist/engines/buriko/games/aokana/native/movie-fullscreen-state.js';
import {AokanaNativeNotifications} from '../dist/engines/buriko/games/aokana/native/notification-queue.js';
import {AokanaCpuProfile} from '../dist/engines/buriko/games/aokana/native/cpu-profile.js';
import {AokanaImportedTextMaps} from '../dist/engines/buriko/games/aokana/native/imported-text-maps.js';

// Ordinary configured CPUID primitives; no native program or hardware probe is executed.
function cpuProfile() {
  let tick = 0,
    timestamp = 0n;
  const cpu = new AokanaCpuProfile({
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
  }, new AokanaNativeClock(() => (tick += 125)));
  assert.equal(cpu.initialize(), true);
  return cpu;
}

function fixture() {
  let tick = 100;
  const calls = [],
    context = {
      createImageData: (width, height) => ({width, height, data: new Uint8ClampedArray(width * height * 4)}),
      save() {}, restore() {}, resetTransform() {},
      fillRect: (...rectangle) => calls.push(['clear', ...rectangle]),
    },
    document = {defaultView: {}, activeElement: null},
    parent = {style: {}, children: [], append(child) {this.children.push(child);}, setAttribute(name, value) {this[name] = value;}},
    canvas = {
      width: 0, height: 0, style: {}, ownerDocument: document,
      addEventListener() {}, removeEventListener() {}, getContext: () => context,
      focus() {document.activeElement = this; calls.push(['focus']);},
    };
  const display = new AokanaNativeDisplayState(16, 8);
  display.setSizePreset(2, 4, 2);
  display.requestedWidth = 8;
  display.requestedHeight = 4;
  display.frameInsetWidth = display.frameInsetHeight = 2;
  display.windowClientOrigin[1] = -1;
  display.monitors = [[0, 0, 16, 8]];
  const clock = new AokanaNativeClock(() => tick),
    ticks = new AokanaSystemTicks({now: () => tick}),
    input = new AokanaNativeInput(display, clock),
    messages = new AokanaWindowMessages(input),
    compositor = new AokanaBitmapCompositor(),
    allocator = new AokanaDistributedAllocator(1),
    environment = new AokanaDisplayObjectEnvironment(compositor, new AokanaDisplayDamage(64, {left: 0, top: 0, right: 3, bottom: 1})),
    manager = new AokanaDisplayManager(environment, new AokanaSurfaces(null, compositor, allocator), display),
    mode = {width: 16, height: 8, refreshRate: 60, format: 22},
    adapters = new AokanaDisplayAdapters(display, [{monitor: 0, pixelShaderVersion: 0xffff0300, mode}], 0,
      () => [display.windowX, display.windowY,
        display.windowX + (parseInt(parent.style.width) || 10), display.windowY + (parseInt(parent.style.height) || 6)]),
    device = new AokanaDisplayDevice(canvas, manager, clock, adapters),
    text = new AokanaNativeText(),
    dialogs = new AokanaEngineDialogs({}, text, clock, input, new AokanaNativeCursor(canvas), device, display, null, new Uint8Array([0])),
    host = new AokanaBrowserMainWindow(document, parent, canvas, manager, {
      isReady: () => true, presentTransient: () => 0, inlinePaintSuppressed: () => false, geometryChanged: (value) => controller.noteGeometryChange(value),
    }),
    trails = new AokanaDisplayMouseTrails(new AokanaNativeRegistry(new MemoryStore()), dialogs),
    localized = new AokanaLocalizedMessages(text, new AokanaNativeLanguage(() => 0x409), new AokanaImportedTextMaps(text)),
    inline = new AokanaInlineTextControl(host, new AokanaNativeFonts(text), dialogs, messages, new AokanaKeyboardMessages(messages)),
    fullscreenMovie = new AokanaFullscreenMovieState(),
    notifications = new AokanaNativeNotifications(),
    controller = new AokanaDisplayController(manager, device, adapters, host, cpuProfile(), ticks, trails, localized, messages, fullscreenMovie, inline, notifications);
  messages.createMainTarget();
  return {controller, display, manager, device, adapters, mode, input, messages, canvas, parent, notifications, calls, setTick: (value) => {tick = value;}};
}

test('ordinary display mode creation and reset share geometry, descriptor budget and texture attachment', async () => {
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
  assert.deepEqual(s.calls.filter(([call]) => call === 'focus'), [['focus'], ['focus']]);
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
  s.adapters.records.push({monitor: 1, pixelShaderVersion: 0xffff0200,
    mode: {width: 20, height: 8, refreshRate: 75, format: 22}});
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
  const display = new AokanaNativeDisplayState(100, 100);
  display.monitors = [[0, 0, 100, 100], [100, 0, 220, 100]];
  let rectangle = [80, 10, 140, 70];
  const records = [
    {monitor: 0, pixelShaderVersion: 0xffff0300, mode: {width: 100, height: 100, refreshRate: 60, format: 22}},
    {monitor: 1, pixelShaderVersion: 0xffff0300, mode: {width: 120, height: 100, refreshRate: 75, format: 22}},
  ];
  const adapters = new AokanaDisplayAdapters(display, records, 0, () => rectangle);
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
