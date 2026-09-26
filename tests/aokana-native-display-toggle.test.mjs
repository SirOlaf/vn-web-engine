import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {AokanaEngineErrors} from '../dist/engines/buriko/games/aokana/native/engine-errors.js';
import {createGroup80DisplayToggle} from '../dist/engines/buriko/games/aokana/native/group-80-display-toggle.js';
import {AokanaMainWindowMessageReceiver} from '../dist/engines/buriko/games/aokana/native/main-window-messages.js';
import {AokanaKnobDisplays} from '../dist/engines/buriko/games/aokana/native/knob-displays.js';
import {AokanaWindowMessages as AokanaWaitWindowMessages} from '../dist/engines/buriko/games/aokana/native/procedure.js';
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
import {
  AokanaEngineDialogs,
  AokanaNativeCursor,
} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
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
  const cpu = new AokanaCpuProfile(
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
    new AokanaNativeClock(() => (tick += 125)),
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
    environment = new AokanaDisplayObjectEnvironment(
      compositor,
      new AokanaDisplayDamage(64, {left: 0, top: 0, right: 3, bottom: 1}),
    ),
    manager = new AokanaDisplayManager(
      environment,
      new AokanaSurfaces(null, compositor, allocator),
      display,
    ),
    mode = {width: 16, height: 8, refreshRate: 60, format: 22},
    adapters = new AokanaDisplayAdapters(
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
    device = new AokanaDisplayDevice(canvas, manager, clock, adapters),
    text = new AokanaNativeText(),
    dialogs = new AokanaEngineDialogs(
      {},
      text,
      clock,
      input,
      new AokanaNativeCursor(canvas),
      device,
      display,
      null,
      new Uint8Array([0]),
    ),
    host = new AokanaBrowserMainWindow(document, parent, canvas, manager, {
      isReady: () => true,
      presentTransient: () => 0,
      inlinePaintSuppressed: () => false,
      geometryChanged: (value) => controller.noteGeometryChange(value),
    }),
    trails = new AokanaDisplayMouseTrails(new AokanaNativeRegistry(new MemoryStore()), dialogs),
    localized = new AokanaLocalizedMessages(
      text,
      new AokanaNativeLanguage(() => 0x409),
      new AokanaImportedTextMaps(text),
    ),
    inline = new AokanaInlineTextControl(
      host,
      new AokanaNativeFonts(text),
      dialogs,
      messages,
      new AokanaKeyboardMessages(messages),
    ),
    fullscreenMovie = new AokanaFullscreenMovieState(),
    notifications = new AokanaNativeNotifications(),
    controller = new AokanaDisplayController(
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
    files = new AokanaProgramFiles(
      new StoredFileSystem(new MemoryStore()),
      s.text,
      new AokanaProgramMedia(),
      new AokanaMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\'),
    ),
    errors = new AokanaEngineErrors(
      files,
      s.dialogs,
      s.text.encodeWide('C:\\', 1),
      s.text.encodeWide('C:\\', 1),
    ),
    [slot] = createGroup80DisplayToggle(s.controller, errors),
    memory = new AokanaBpMemory(new Uint8Array(0x1000)),
    thread = new AokanaBpThread({id: 1, operandCapacity: 8, moduleCapacity: 32, frameCapacity: 0}),
    keyboard = new AokanaKeyboardMessages(s.messages),
    waits = new AokanaWaitWindowMessages(),
    knobs = new AokanaKnobDisplays(s.manager, s.input, s.notifications);
  new AokanaMainWindowMessageReceiver(
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
