import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBrowserMainWindow} from '../dist/engines/buriko/native/browser-main-window.js';
import {BurikoDisplayAdapters} from '../dist/engines/buriko/native/display-adapters.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {BurikoBitmapCompositor} from '../dist/engines/buriko/native/bitmap-compositor.js';
import {BurikoDisplayDamage} from '../dist/engines/buriko/native/display-damage.js';
import {BurikoDisplayObjectEnvironment} from '../dist/engines/buriko/native/display-object.js';
import {BurikoSurfaces} from '../dist/engines/buriko/native/surfaces.js';
import {BurikoDistributedAllocator} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoDisplayManager} from '../dist/engines/buriko/native/display-manager.js';

class Element {
  style = {};
  children = [];
  layoutExtraWidth = 0;
  collapsed = false;
  append(child) {
    this.children.push(child);
  }
  setAttribute() {}
  getBoundingClientRect() {
    const left = Number.parseFloat(this.style.left ?? '0'),
      top = Number.parseFloat(this.style.top ?? '0'),
      width = this.collapsed
        ? 0
        : Number.parseFloat(this.style.width ?? '0') + this.layoutExtraWidth,
      height = this.collapsed ? 0 : Number.parseFloat(this.style.height ?? '0');
    return {left, top, right: left + width, bottom: top + height, width, height};
  }
}

test('main host supplies measured outer screen rectangle and retains it across minimize', () => {
  const display = new BurikoNativeDisplayState(1000, 1000),
    compositor = new BurikoBitmapCompositor(),
    allocator = new BurikoDistributedAllocator(1),
    manager = new BurikoDisplayManager(
      new BurikoDisplayObjectEnvironment(
        compositor,
        new BurikoDisplayDamage(64, {left: 0, top: 0, right: 999, bottom: 999}),
      ),
      new BurikoSurfaces(null, compositor, allocator),
      display,
    ),
    parent = new Element(),
    surface = new Element(),
    host = new BurikoBrowserMainWindow({}, parent, surface, manager, {
      isReady: () => false,
      presentTransient: () => 0,
      inlinePaintSuppressed: () => false,
      geometryChanged() {},
    });
  display.monitors = [
    [0, 0, 1000, 1000],
    [1000, 0, 2000, 1000],
  ];
  display.frameInsetWidth = 20;
  display.frameInsetHeight = 30;
  let viewportOriginX = 100;
  host.bindViewportScreenMapping(() => ({
    originX: viewportOriginX,
    originY: 200,
    nativePixelsPerCssX: 2,
    nativePixelsPerCssY: 2,
  }));
  const adapters = new BurikoDisplayAdapters(
    display,
    [
      {
        monitor: 0,
        pixelShaderVersion: 0,
        mode: {width: 1000, height: 1000, refreshRate: 60, format: 22},
      },
      {
        monitor: 1,
        pixelShaderVersion: 0,
        mode: {width: 1000, height: 1000, refreshRate: 60, format: 22},
      },
    ],
    0,
    () => host.readRestoredOuterScreenRectangle(),
  );
  host.applyWindowedGeometry(200, 100, [100, 100], 0x10000000);
  assert.equal(display.requestedWidth, 200);
  assert.equal(parent.style.width, '220px');
  assert.deepEqual(host.readRestoredOuterScreenRectangle(), [300, 400, 740, 660]);
  assert.equal(adapters.currentMonitor(), 0);

  // A live layout change affects the actual outer box without changing requested client size.
  parent.layoutExtraWidth = 30;
  assert.deepEqual(host.readRestoredOuterScreenRectangle(), [300, 400, 800, 660]);
  host.captureOuterRectangleBeforeMinimize();
  parent.collapsed = true;
  viewportOriginX = 400;
  assert.deepEqual(host.readRestoredOuterScreenRectangle(), [300, 400, 800, 660]);
  assert.equal(adapters.currentMonitor(), 0);

  parent.collapsed = false;
  host.applyPosition(500, 100);
  host.refreshOuterRectangleAfterRestore();
  assert.deepEqual(host.readRestoredOuterScreenRectangle(), [1400, 400, 1900, 660]);
  assert.equal(adapters.currentMonitor(), 1);

  host.applyPosition(1200, 100);
  display.geometryChanged = 0;
  assert.equal(adapters.currentMonitor(), 0);
  display.geometryChanged = 1;
  assert.equal(adapters.currentMonitor(), 1);
});
