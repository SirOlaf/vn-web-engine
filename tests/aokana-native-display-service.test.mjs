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
import {createGroup80DisplayService} from '../dist/engines/buriko/native/group-80-display-service.js';
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

test('80 display services reconfigure the shared device, geometry, mode and presentation policy', async () => {
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
    slots = createGroup80DisplayService(s.controller, errors),
    memory = new BurikoBpMemory(new Uint8Array(0x1000)),
    thread = new BurikoBpThread({id: 1, operandCapacity: 8, moduleCapacity: 32, frameCapacity: 0});
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
