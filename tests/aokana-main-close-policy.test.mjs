import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBrowserMainWindow} from '../dist/engines/buriko/games/aokana/native/browser-main-window.js';
import {AokanaNativeDisplayState} from '../dist/engines/buriko/games/aokana/native/display-state.js';
import {AokanaNativeClock} from '../dist/engines/buriko/games/aokana/native/clock.js';
import {AokanaNativeInput} from '../dist/engines/buriko/games/aokana/native/input.js';
import {AokanaWindowMessages} from '../dist/engines/buriko/games/aokana/native/window-messages.js';
import {AokanaDisplayManager} from '../dist/engines/buriko/games/aokana/native/display-manager.js';
import {AokanaDisplayObjectEnvironment} from '../dist/engines/buriko/games/aokana/native/display-object.js';
import {AokanaDisplayDamage} from '../dist/engines/buriko/games/aokana/native/display-damage.js';
import {AokanaBitmapCompositor} from '../dist/engines/buriko/games/aokana/native/bitmap-compositor.js';
import {AokanaSurfaces} from '../dist/engines/buriko/games/aokana/native/surfaces.js';
import {AokanaDistributedAllocator} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';

class Element {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.style = {};
    this.children = [];
    this.listeners = new Map();
    this.disabled = false;
  }
  append(child) {
    this.children.push(child);
    child.parent = this;
  }
  setAttribute(name, value) {
    this[name] = value;
  }
  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }
  click() {
    if (!this.disabled) this.listeners.get('click')?.();
  }
}

test('main Close policy retains native menu state without a browser button and posts on the shared main target', () => {
  const document = {createElement: (tag) => new Element(tag)},
    parent = document.createElement('div'),
    canvas = document.createElement('canvas'),
    display = new AokanaNativeDisplayState(16, 8),
    compositor = new AokanaBitmapCompositor(),
    manager = new AokanaDisplayManager(
      new AokanaDisplayObjectEnvironment(
        compositor,
        new AokanaDisplayDamage(64, {left: 0, top: 0, right: 15, bottom: 7}),
      ),
      new AokanaSurfaces(null, compositor, new AokanaDistributedAllocator(1)),
      display,
    ),
    input = new AokanaNativeInput(display, new AokanaNativeClock(() => 0)),
    messages = new AokanaWindowMessages(input),
    host = new AokanaBrowserMainWindow(document, parent, canvas, manager, {
      isReady: () => true,
      presentTransient: () => 0,
      inlinePaintSuppressed: () => false,
      geometryChanged() {},
    });
  messages.createMainTarget();
  host.bindCloseMenu(input, messages);
  assert.deepEqual(parent.children, [canvas]);
  assert.equal(host.closePolicy, 1);
  assert.equal(host.closeMenuEnabled, true);
  host.postClose();
  assert.deepEqual(messages.take(), {target: 'main', message: 0x10, wParam: 0, lParam: 0});

  host.setClosePolicy(0);
  assert.equal(host.closeMenuEnabled, false);
  host.postClose();
  assert.deepEqual(messages.take(), {target: 'main', message: 0x10, wParam: 0, lParam: 0});

  input.inputActive = true;
  host.setClosePolicy(0x80000000);
  assert.equal(host.closePolicy, 0x80000000);
  assert.equal(host.closeMenuEnabled, false);
  host.setCloseMenuEnabled(true); // WM_SIZE restore can enable the menu independently.
  host.setClosePolicy(0);
  assert.equal(host.closePolicy, 0);
  assert.equal(host.closeMenuEnabled, true);
  host.postClose();
  assert.deepEqual(messages.take(), {target: 'main', message: 0x10, wParam: 0, lParam: 0});

  input.inputActive = false;
  host.setClosePolicy(2);
  assert.equal(host.closePolicy, 2);
  assert.equal(host.closeMenuEnabled, true);

  const menuCalls = [],
    setMenu = host.setCloseMenuEnabled.bind(host);
  host.setCloseMenuEnabled = (enabled) => {
    menuCalls.push([enabled, input.inputActive]);
    setMenu(enabled);
  };
  input.iconic = 1;
  input.scriptMinimizeLatch = 1;
  host.setClosePolicy(0);
  menuCalls.length = 0;
  host.applySizeMenuTail(0n, input);
  assert.deepEqual(menuCalls, [[true, false]]); // Enable menu before publishing active input.
  assert.equal(input.inputActive, true);
  assert.equal(host.closePolicy, 0);
  assert.equal(host.closeMenuEnabled, true);

  host.setClosePolicy(0x80000000);
  assert.equal(host.closeMenuEnabled, true); // Active policy writes retain menu state.
  menuCalls.length = 0;
  host.applySizeMenuTail(1, input);
  assert.deepEqual(menuCalls, []); // Nonzero policy makes minimize leave the menu alone.
  assert.equal(input.inputActive, false);
  assert.equal(host.closeMenuEnabled, true);
  host.setClosePolicy(0);
  assert.equal(host.closeMenuEnabled, false); // Inactive policy writes update the menu.

  menuCalls.length = 0;
  host.applySizeMenuTail(0, input);
  assert.deepEqual(menuCalls, [[true, false]]);
  menuCalls.length = 0;
  host.applySizeMenuTail(0x10000, input); // Full wParam, not its low word.
  assert.deepEqual(menuCalls, []);
  assert.equal(input.inputActive, true);
  host.applySizeMenuTail(1n, input);
  assert.deepEqual(menuCalls, [[false, true]]); // Disable menu before clearing active input.
  assert.equal(input.inputActive, false);
  assert.equal(host.closeMenuEnabled, false);
  assert.equal(input.iconic, 1);
  assert.equal(input.scriptMinimizeLatch, 1);
});
