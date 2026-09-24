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
import {createGroup80DisplayService} from '../dist/engines/buriko/games/aokana/native/group-80-display-service.js';
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

test('80 display services reconfigure the shared device, geometry, mode and presentation policy', async () => {
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
    slots = createGroup80DisplayService(s.controller, errors),
    memory = new AokanaBpMemory(new Uint8Array(0x1000)),
    thread = new AokanaBpThread({id: 1, operandCapacity: 8, moduleCapacity: 32, frameCapacity: 0});
  const invoke = async (slot, args = [], outputs = 0) => {
    for (const value of args) push32(thread, value);
    assert.equal(
      await slots.find((entry) => entry.secondary === slot).execute({thread, memory}),
      0,
    );
    const result = outputs ? pop32(thread) : undefined;
    assert.equal(thread.stackIndex, 0);
    return result;
  };
  await s.controller.initialize();
  s.display.aspectWidth = 8;
  s.display.aspectHeight = 4;
  await invoke(0x60, [2, 1, 0]);
  assert.deepEqual([s.display.aspectWidth, s.display.aspectHeight], [4, 2]);
  assert.equal(s.canvas.width, 8);
  assert.equal(await invoke(0x61, [], 1), 0);
  await invoke(0x63, [0]);
  assert.equal(s.display.effectiveDisplayMode(), 1);
  await invoke(0x63, [1]);
  assert.equal(s.display.effectiveDisplayMode(), 0);
  assert.equal(await invoke(0x6f, [], 1), 0);
  s.mode.width = 20;
  await invoke(0x60, [2, 1, 1]);
  assert.equal(await invoke(0x61, [], 1), 1);
  assert.equal(s.canvas.width, 20);
  assert.equal(await invoke(0x6f, [], 1), 1);
  await invoke(0x6e, [0]);
  assert.equal(s.display.verticalSynchronization, 0);
  assert.equal(s.manager.displayContext().bitmap.width, 4);
  const output = {waitCount: 99};
  assert.equal(await s.device.present(output), 0);
  assert.equal(output.waitCount, 0);
  assert.equal(s.calls.filter(([call]) => call === 'vsync').length, 0);
  await invoke(0x6e, [1]);
  assert.equal(await s.device.present(output), 0);
  assert.equal(s.calls.filter(([call]) => call === 'vsync').length, 1);
  assert.equal(s.calls.filter(([call]) => call === 'present').length, 2);
  assert.equal(s.device.fullscreen, 1);
  await invoke(0x60, [2, 1, 0]);
  assert.equal(await invoke(0x61, [], 1), 0);
  assert.equal(s.canvas.width, 8);
});
