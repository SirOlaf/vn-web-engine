import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaMainWindowCallbackBinding} from '../dist/engines/buriko/games/aokana/native/main-window-callbacks.js';
import {AokanaBrowserMainWindow} from '../dist/engines/buriko/games/aokana/native/browser-main-window.js';
import {AokanaDisplayController} from '../dist/engines/buriko/games/aokana/native/display-controller.js';
import {AokanaDisplayFrames} from '../dist/engines/buriko/games/aokana/native/display-frames.js';
import {AokanaDisplayAdapters} from '../dist/engines/buriko/games/aokana/native/display-adapters.js';
import {AokanaDisplayDevice} from '../dist/engines/buriko/games/aokana/native/display-device.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaNativeFonts} from '../dist/engines/buriko/games/aokana/native/fonts.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaBitmapText} from '../dist/engines/buriko/games/aokana/native/font-bitmap.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaSystemTicks} from '../dist/engines/buriko/games/aokana/native/system-ticks.js';
import {AokanaNativeInput} from '../dist/engines/buriko/games/aokana/native/input.js';
import {AokanaWindowMessages} from '../dist/engines/buriko/games/aokana/native/window-messages.js';
import {AokanaKeyboardMessages} from '../dist/engines/buriko/games/aokana/native/keyboard-messages.js';
import {
  AokanaEngineDialogs,
  AokanaNativeCursor,
} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';
import {AokanaDiagnosticDialogs} from '../dist/engines/buriko/games/aokana/native/modal.js';
import {AokanaInlineTextControl} from '../dist/engines/buriko/games/aokana/native/inline-text-control.js';
import {AokanaChildWindows} from '../dist/engines/buriko/games/aokana/native/child-windows.js';
import {AokanaNativeRegistry} from '../dist/engines/buriko/games/aokana/native/windows-registry.js';
import {AokanaDisplayMouseTrails} from '../dist/engines/buriko/games/aokana/native/display-mouse-trails.js';
import {AokanaLocalizedMessages} from '../dist/engines/buriko/games/aokana/native/localized-messages.js';
import {AokanaNativeLanguage} from '../dist/engines/buriko/games/aokana/native/group-81-language.js';
import {AokanaImportedTextMaps} from '../dist/engines/buriko/games/aokana/native/imported-text-maps.js';
import {AokanaFullscreenMovieState} from '../dist/engines/buriko/games/aokana/native/movie-fullscreen-state.js';
import {AokanaNativeNotifications} from '../dist/engines/buriko/games/aokana/native/notification-queue.js';
import {AokanaCpuProfile} from '../dist/engines/buriko/games/aokana/native/cpu-profile.js';
import {AokanaFrameMetrics} from '../dist/engines/buriko/games/aokana/native/frame-metrics.js';
import {AokanaBrowserPerformanceCounter} from '../dist/engines/buriko/games/aokana/native/system-timing.js';
import {AokanaMovieRegistry} from '../dist/engines/buriko/games/aokana/native/movie-registry.js';

test('main-window callbacks bind the same actual controller and frames after host construction', async () => {
  const document = {defaultView: null, activeElement: null},
    parent = {
      style: {},
      children: [],
      append(child) {
        this.children.push(child);
      },
      setAttribute() {},
    },
    canvas = {
      style: {},
      ownerDocument: document,
      addEventListener() {},
      removeEventListener() {},
      getContext() {
        assert.fail('uninitialized frame forwarding must not draw');
      },
    },
    display = new AokanaNativeDisplayState(1920, 1080);
  display.monitors = [[0, 0, 1920, 1080]];
  display.requestedWidth = 800;
  display.requestedHeight = 600;
  display.windowMoveImmediate = 1;

  const clock = new AokanaNativeClock(() => 0),
    ticks = new AokanaSystemTicks({now: () => 0}),
    text = new AokanaNativeText(),
    fonts = new AokanaNativeFonts(text),
    compositor = new AokanaBitmapCompositor(),
    allocator = new AokanaDistributedAllocator(1),
    surfaces = new AokanaSurfaces(fonts, compositor, allocator),
    environment = new AokanaDisplayObjectEnvironment(
      compositor,
      new AokanaDisplayDamage(64, {left: 0, top: 0, right: 799, bottom: 599}),
    ),
    manager = new AokanaDisplayManager(environment, surfaces, display),
    callbacks = new AokanaMainWindowCallbackBinding(display),
    host = new AokanaBrowserMainWindow(document, parent, canvas, manager, callbacks),
    adapters = new AokanaDisplayAdapters(
      display,
      [
        {
          monitor: 0,
          pixelShaderVersion: 0xffff0300,
          mode: {width: 1920, height: 1080, refreshRate: 60, format: 22},
        },
      ],
      0,
      () => [display.windowX, display.windowY, display.windowX + 800, display.windowY + 600],
    ),
    device = new AokanaDisplayDevice(canvas, manager, clock, adapters),
    input = new AokanaNativeInput(display, clock),
    messages = new AokanaWindowMessages(input),
    keyboard = new AokanaKeyboardMessages(messages),
    dialogs = new AokanaEngineDialogs(
      new AokanaDiagnosticDialogs(document, parent),
      text,
      clock,
      input,
      new AokanaNativeCursor(canvas),
      device,
      display,
      null,
      new Uint8Array(),
    ),
    inline = new AokanaInlineTextControl(host, fonts, dialogs, messages, keyboard),
    fullscreenMovie = new AokanaFullscreenMovieState(),
    cpu = new AokanaCpuProfile(
      {
        cpuid: () => [0, 0, 0, 0],
        readTimestampCounter: () => 0n,
        setCurrentThreadAffinity: () => 1n,
        logicalProcessorCount: () => 1,
        logicalProcessorInformation: () => [{relationship: 0, processorMask: 1n}],
      },
      clock,
    ),
    controller = new AokanaDisplayController(
      manager,
      device,
      adapters,
      host,
      cpu,
      ticks,
      new AokanaDisplayMouseTrails(new AokanaNativeRegistry(new MemoryStore()), dialogs),
      new AokanaLocalizedMessages(
        text,
        new AokanaNativeLanguage(() => 0x409),
        new AokanaImportedTextMaps(text),
      ),
      messages,
      fullscreenMovie,
      inline,
      new AokanaNativeNotifications(),
    ),
    children = new AokanaChildWindows(
      document,
      parent,
      {},
      text,
      surfaces,
      compositor,
      new AokanaBitmapText(fonts, compositor),
      dialogs,
      messages,
      keyboard,
      {frameWidth: 0, frameHeight: 0, verticalScrollbarWidth: 0, horizontalScrollbarHeight: 0},
      new Uint8Array(),
      canvas,
    ),
    frames = new AokanaDisplayFrames(
      manager,
      device,
      clock,
      ticks,
      new AokanaFrameMetrics(new AokanaBrowserPerformanceCounter({now: () => 0}), clock, device),
      new AokanaMovieRegistry(),
      fullscreenMovie,
      inline,
      children,
    );

  const otherDevice = new AokanaDisplayDevice(canvas, manager, clock, adapters);
  const mismatchedFrames = new AokanaDisplayFrames(
    manager,
    otherDevice,
    clock,
    ticks,
    frames.metrics,
    frames.movies,
    fullscreenMovie,
    inline,
    children,
  );
  assert.throws(
    () => callbacks.bind(host, controller, mismatchedFrames),
    /shared host, controller and frames/,
  );
  callbacks.bind(host, controller, frames);
  assert.throws(() => callbacks.bind(host, controller, frames), /already bound/);
  assert.equal(host.move(40, 50), 1);
  assert.equal(display.geometryPreference, 50);
  assert.equal(display.geometryChanged, 1);
  assert.equal(callbacks.inlinePaintSuppressed(), false);
  display.inlinePaintSuppression = 1;
  assert.equal(callbacks.inlinePaintSuppressed(), true);
  assert.equal(await callbacks.presentTransient(3, 4), 0);
  assert.equal(callbacks.isReady(), false);
});
