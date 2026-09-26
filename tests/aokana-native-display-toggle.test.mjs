import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoMountedProgramPaths} from '../dist/engines/buriko/native/program-paths.js';
import {BurikoEngineErrors} from '../dist/engines/buriko/native/engine-errors.js';
import {createGroup80DisplayToggle} from '../dist/engines/buriko/native/group-80-display-toggle.js';
import {BurikoMainWindowMessageReceiver} from '../dist/engines/buriko/native/main-window-messages.js';
import {BurikoKnobDisplays} from '../dist/engines/buriko/native/knob-displays.js';
import {BurikoWindowMessages as BurikoWaitWindowMessages} from '../dist/engines/buriko/native/procedure.js';
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
      putImageData() {
        calls.push(['present']);
      },
      fillRect: (...rectangle) => calls.push(['clear', ...rectangle]),
    },
    document = {
      defaultView: {
        requestAnimationFrame(callback) {
          calls.push(['vsync']);
          callback(0);
        },
      },
      activeElement: null,
    },
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
    manager = new BurikoDisplayManager(
      environment,
      new BurikoSurfaces(null, compositor, allocator),
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
    text = new BurikoNativeText(),
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
    text,
    dialogs,
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

test('80:62 shares configured keyboard toggles with actual message dispatch and display polling', async () => {
  const s = fixture(),
    files = new BurikoProgramFiles(
      new StoredFileSystem(new MemoryStore()),
      s.text,
      new BurikoProgramMedia(),
      new BurikoMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\'),
    ),
    errors = new BurikoEngineErrors(
      files,
      s.dialogs,
      s.text.encodeWide('C:\\', 1),
      s.text.encodeWide('C:\\', 1),
    ),
    [slot] = createGroup80DisplayToggle(s.controller, errors),
    memory = new BurikoBpMemory(new Uint8Array(0x1000)),
    thread = new BurikoBpThread({id: 1, operandCapacity: 8, moduleCapacity: 32, frameCapacity: 0}),
    keyboard = new BurikoKeyboardMessages(s.messages),
    waits = new BurikoWaitWindowMessages(),
    knobs = new BurikoKnobDisplays(s.manager, s.input, s.notifications);
  new BurikoMainWindowMessageReceiver(
    s.messages,
    waits,
    s.input,
    s.notifications,
    s.controller.host,
    knobs,
    s.controller,
  );
  const configure = async (enabled, keys) => {
    if (keys !== null) {
      keys.forEach((key, index) => memory.writeU32(thread, 0x100 + index * 4, key));
      memory.writeU32(thread, 0x100 + keys.length * 4, 0);
    }
    push32(thread, enabled);
    push32(thread, keys === null ? 0 : 0x100);
    assert.equal(await slot.execute({thread, memory}), 0);
    assert.equal(thread.stackIndex, 0);
  };
  const event = (type, code, keyCode) => {
    keyboard.post('main', {type, code, keyCode, repeat: false, getModifierState: () => false});
    while (s.messages.dispatchNext() !== null) {}
  };
  const notifications = () => {
    const result = [];
    for (let record; (record = s.notifications.take()) !== null;) result.push(record);
    return result;
  };
  await s.controller.initialize();
  await configure(2, [0x77, 0x79]);
  // Configuration copies caller keys, and the native poll gate is independent of foreground.
  memory.writeU32(thread, 0x100, 0x78);
  assert.equal(s.input.foreground, false);
  event('keydown', 'F8', 0x77);
  assert.equal(s.display.modeChangePending, 1);
  await s.controller.poll();
  assert.equal(s.device.fullscreen, 1);
  assert.deepEqual(notifications(), [
    {type: 3, value1: 0x77, value2: 0},
    {type: 1, value1: 1, value2: 0},
  ]);
  event('keyup', 'F8', 0x77);
  event('keydown', 'F10', 0x79);
  await s.controller.poll();
  assert.equal(s.device.fullscreen, 0);
  assert.deepEqual(notifications(), [
    {type: 3, value1: 0x79, value2: 0},
    {type: 1, value1: 0, value2: 0},
  ]);
  event('keyup', 'F10', 0x79);
  await configure(0, [0x78]);
  event('keydown', 'F8', 0x77);
  assert.equal(s.display.modeChangePending, 0);
  s.controller.requestModeToggle();
  await s.controller.poll();
  assert.equal(s.device.fullscreen, 0);
  assert.equal(s.display.modeChangePending, 0);
  assert.deepEqual(notifications(), [{type: 3, value1: 0x77, value2: 0}]);
  event('keyup', 'F8', 0x77);
  await configure(1, [0x12]);
  event('keydown', 'AltLeft', 0x12);
  event('keyup', 'AltLeft', 0x12);
  await s.controller.poll();
  assert.equal(s.device.fullscreen, 1);
  assert.deepEqual(notifications(), [
    {type: 3, value1: 0x12, value2: 0},
    {type: 1, value1: 1, value2: 0},
  ]);
  await configure(1, null);
  assert.equal(s.controller.containsModeToggleKey(0x12), false);
});
