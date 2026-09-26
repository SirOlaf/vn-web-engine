import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoMainWindowShowState} from '../dist/engines/buriko/native/main-window-show-state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

function memoryContext() {
  const calls = [];
  return {
    calls,
    save() {
      calls.push('save');
    },
    resetTransform() {},
    restore() {
      calls.push('restore');
    },
    set globalAlpha(_) {},
    set globalCompositeOperation(_) {},
    set fillStyle(_) {},
    fillRect(...rectangle) {
      calls.push(['fillRect', ...rectangle]);
    },
  };
}

test('targeted UpdateWindow paints main without consuming posted FIFO or another target', async () => {
  const context = memoryContext();
  const fixture = await createMountedVmFixture({canvas2dContext: context});
  const {graph} = fixture;
  try {
    graph.host.surface.width = 4;
    graph.host.surface.height = 2;
    const numeric = graph.messages.createTarget();
    graph.messages.bindQueuedNumericTarget(numeric, () => true);
    graph.messages.post({target: numeric, message: 0x9001, wParam: 0, lParam: 0});
    graph.messages.invalidate(numeric);
    graph.messages.invalidate('main');
    assert.equal(await graph.queuedDispatcher.updateMainWindow(), 0);
    assert.deepEqual(context.calls, ['save', ['fillRect', 0, 0, 4, 2], 'restore']);
    assert.equal(graph.messages.pending, 2);
    assert.equal((await graph.queuedDispatcher.dispatchNext()).event.message.message, 0x9001);
    assert.equal((await graph.queuedDispatcher.dispatchNext()).event.message.target, numeric);
    assert.equal(await graph.queuedDispatcher.updateMainWindow(), null);
    graph.messages.forgetTarget(numeric);
  } finally {
    await fixture.close();
  }
});

test('show-state order applies pending position, paints, publishes raw state and clears transient keys', async () => {
  const context = memoryContext();
  const fixture = await createMountedVmFixture({canvas2dContext: context});
  const {graph} = fixture;
  try {
    graph.host.surface.width = 4;
    graph.host.surface.height = 2;
    const show = new BurikoMainWindowShowState(
      graph.host,
      graph.input,
      graph.messages,
      graph.queuedDispatcher,
    );
    graph.host.document.visibilityState = 'visible';
    graph.host.document.hasFocus = () => true;
    graph.host.document.activeElement = graph.host.surface;
    graph.host.parent.contains = (node) => node === graph.host.surface;
    const observations = [];
    const originalWait = graph.waits.dispatch.bind(graph.waits);
    graph.waits.dispatch = (message, wParam, lParam) => {
      if (message === 0xf)
        observations.push({
          position: [graph.display.windowX, graph.display.windowY],
          pending: graph.display.windowPositionPending,
          raw: graph.display.windowMoveImmediate,
          foreground: graph.input.foreground,
          visible: graph.host.parent.style.visibility,
        });
      originalWait(message, wParam, lParam);
    };
    graph.display.fullscreen = 0;
    graph.display.windowMoveImmediate = 0;
    graph.input.foreground = false;
    graph.display.pendingWindowPosition[0] = 20;
    graph.display.pendingWindowPosition[1] = 30;
    graph.display.windowPositionPending = 1;
    graph.messages.invalidate('main');
    graph.input.recordKeyDown(65);
    await show.setShowState(0x1234);
    assert.deepEqual(observations, [
      {
        position: [20, 30],
        pending: 1,
        raw: 0,
        foreground: false,
        visible: 'visible',
      },
    ]);
    assert.equal(graph.display.geometryPreference, 30);
    assert.equal(graph.display.windowPositionPending, 0);
    assert.equal(graph.display.windowMoveImmediate, 0x1234);
    assert.equal(graph.input.foreground, true);
    assert.equal(graph.input.consumeKey(65), 0);
    assert.equal(graph.messages.pending, 0);

    graph.display.windowPositionPending = 1;
    graph.display.pendingWindowPosition[0] = 40;
    graph.display.pendingWindowPosition[1] = 50;
    graph.messages.invalidate('main');
    await show.setShowState(0);
    assert.equal(graph.host.parent.style.visibility, 'hidden');
    assert.equal(graph.display.windowPositionPending, 1);
    assert.equal(graph.display.windowMoveImmediate, 0);
    assert.equal(graph.input.foreground, false);
    assert.equal(graph.messages.pending, 1);
    graph.messages.validatePaint(graph.messages.takePaint('main'));

    graph.display.fullscreen = 1;
    graph.display.windowPositionPending = 1;
    graph.messages.invalidate('main');
    await show.setShowState(7);
    assert.equal(graph.display.windowPositionPending, 0);
    assert.equal(graph.display.windowX, 20);
    assert.equal(graph.display.windowMoveImmediate, 7);
    assert.equal(graph.messages.pending, 1);
    graph.messages.validatePaint(graph.messages.takePaint('main'));

    graph.messages.send('main', 2, 0, 0);
    graph.input.recordKeyDown(66);
    await show.setShowState(9);
    assert.equal(graph.input.recordKeyDown(66), true);
    assert.equal(graph.display.windowMoveImmediate, 7);
  } finally {
    await fixture.close();
  }
});
