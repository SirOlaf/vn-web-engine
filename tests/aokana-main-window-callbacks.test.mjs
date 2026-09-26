import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoMainWindowCallbackBinding} from '../dist/engines/buriko/native/main-window-callbacks.js';
import {BurikoBrowserMainWindow} from '../dist/engines/buriko/native/browser-main-window.js';
import {BurikoDisplayController} from '../dist/engines/buriko/native/display-controller.js';
import {BurikoDisplayFrames} from '../dist/engines/buriko/native/display-frames.js';
import {BurikoDisplayAdapters} from '../dist/engines/buriko/native/display-adapters.js';
import {BurikoDisplayDevice} from '../dist/engines/buriko/native/display-device.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';
import {BurikoDisplayObjectEnvironment} from '../dist/engines/buriko/native/display-object.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoNativeFonts} from '../dist/engines/buriko/native/fonts.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoBitmapText} from '../dist/engines/buriko/native/font-bitmap.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoSystemTicks} from '../dist/engines/buriko/native/system-ticks.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BurikoWindowMessages} from '../dist/engines/buriko/native/window-messages.js';
import {BurikoKeyboardMessages} from '../dist/engines/buriko/native/keyboard-messages.js';
import {
  BurikoEngineDialogs,
  BurikoNativeCursor,
} from '../dist/engines/buriko/native/engine-dialogs.js';
import {BurikoDiagnosticDialogs} from '../dist/engines/buriko/native/modal.js';
import {BurikoInlineTextControl} from '../dist/engines/buriko/native/inline-text-control.js';
import {BurikoChildWindows} from '../dist/engines/buriko/native/child-windows.js';
import {BurikoNativeRegistry} from '../dist/engines/buriko/native/windows-registry.js';
import {BurikoDisplayMouseTrails} from '../dist/engines/buriko/native/display-mouse-trails.js';
import {BurikoLocalizedMessages} from '../dist/engines/buriko/native/localized-messages.js';
import {BurikoNativeLanguage} from '../dist/engines/buriko/native/group-81-language.js';
import {BurikoImportedTextMaps} from '../dist/engines/buriko/native/imported-text-maps.js';
import {BurikoFullscreenMovieState} from '../dist/engines/buriko/native/movie-fullscreen-state.js';
import {BurikoNativeNotifications} from '../dist/engines/buriko/native/notification-queue.js';
import {BurikoCpuProfile} from '../dist/engines/buriko/native/cpu-profile.js';
import {BurikoFrameMetrics} from '../dist/engines/buriko/native/frame-metrics.js';
import {BurikoBrowserPerformanceCounter} from '../dist/engines/buriko/native/system-timing.js';
import {BurikoMovieRegistry} from '../dist/engines/buriko/native/movie-registry.js';

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
    display = new BurikoNativeDisplayState(1920, 1080);
  display.monitors = [[0, 0, 1920, 1080]];
  display.requestedWidth = 800;
  display.requestedHeight = 600;
  display.windowMoveImmediate = 1;

  const clock = new BurikoNativeClock(() => 0),
    ticks = new BurikoSystemTicks({now: () => 0}),
    text = new BurikoNativeText(),
    fonts = new BurikoNativeFonts(text),
    compositor = new BurikoBitmapCompositor(),
    allocator = new BurikoDistributedAllocator(1),
    surfaces = new BurikoSurfaces(fonts, compositor, allocator),
    environment = new BurikoDisplayObjectEnvironment(
      compositor,
      new BurikoDisplayDamage(64, {left: 0, top: 0, right: 799, bottom: 599}),
    ),
    manager = new BurikoDisplayManager(environment, surfaces, display),
    callbacks = new BurikoMainWindowCallbackBinding(display),
    host = new BurikoBrowserMainWindow(document, parent, canvas, manager, callbacks),
    adapters = new BurikoDisplayAdapters(
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
    device = new BurikoDisplayDevice(canvas, manager, clock, adapters),
    input = new BurikoNativeInput(display, clock),
    messages = new BurikoWindowMessages(input),
    keyboard = new BurikoKeyboardMessages(messages),
    dialogs = new BurikoEngineDialogs(
      new BurikoDiagnosticDialogs(document, parent),
      text,
      clock,
      input,
      new BurikoNativeCursor(canvas),
      device,
      display,
      null,
      new Uint8Array(),
    ),
    inline = new BurikoInlineTextControl(host, fonts, dialogs, messages, keyboard),
    fullscreenMovie = new BurikoFullscreenMovieState(),
    cpu = new BurikoCpuProfile(
      {
        cpuid: () => [0, 0, 0, 0],
        readTimestampCounter: () => 0n,
        setCurrentThreadAffinity: () => 1n,
        logicalProcessorCount: () => 1,
        logicalProcessorInformation: () => [{relationship: 0, processorMask: 1n}],
      },
      clock,
    ),
    controller = new BurikoDisplayController(
      manager,
      device,
      adapters,
      host,
      cpu,
      ticks,
      new BurikoDisplayMouseTrails(new BurikoNativeRegistry(new MemoryStore()), dialogs),
      new BurikoLocalizedMessages(
        text,
        new BurikoNativeLanguage(() => 0x409),
        new BurikoImportedTextMaps(text),
      ),
      messages,
      fullscreenMovie,
      inline,
      new BurikoNativeNotifications(),
    ),
    children = new BurikoChildWindows(
      document,
      parent,
      {},
      text,
      surfaces,
      compositor,
      new BurikoBitmapText(fonts, compositor),
      dialogs,
      messages,
      keyboard,
      {frameWidth: 0, frameHeight: 0, verticalScrollbarWidth: 0, horizontalScrollbarHeight: 0},
      new Uint8Array(),
      canvas,
    ),
    frames = new BurikoDisplayFrames(
      manager,
      device,
      clock,
      ticks,
      new BurikoFrameMetrics(new BurikoBrowserPerformanceCounter({now: () => 0}), clock, device),
      new BurikoMovieRegistry(),
      fullscreenMovie,
      inline,
      children,
    );

  const otherDevice = new BurikoDisplayDevice(canvas, manager, clock, adapters);
  const mismatchedFrames = new BurikoDisplayFrames(
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
