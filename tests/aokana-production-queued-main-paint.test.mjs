import test from 'node:test';
import assert from 'node:assert/strict';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

function memoryContext(width, height) {
  const pixels = new Uint32Array(width * height).fill(0xff4a3b2c);
  const calls = [];
  return {
    pixels,
    calls,
    save() {
      calls.push('save');
    },
    resetTransform() {
      calls.push('resetTransform');
    },
    restore() {
      calls.push('restore');
    },
    set globalAlpha(value) {
      calls.push(['alpha', value]);
    },
    set globalCompositeOperation(value) {
      calls.push(['composite', value]);
    },
    set fillStyle(value) {
      calls.push(['fill', value]);
    },
    fillRect(x, y, w, h) {
      calls.push(['fillRect', x, y, w, h]);
      for (let row = y; row < y + h; row++)
        for (let column = x; column < x + w; column++) pixels[row * width + column] = 0xff000000;
    },
  };
}

test('graph queued dispatcher validates generated main paint after wait broadcast and preserves FIFO', async () => {
  const context = memoryContext(4, 2);
  const fixture = await createMountedVmFixture({canvas2dContext: context});
  const {graph, child} = fixture;
  const {messages, queuedDispatcher, queuedPaint} = graph;
  try {
    graph.host.surface.width = 4;
    graph.host.surface.height = 2;
    assert.equal(queuedDispatcher.messages, messages);
    assert.equal(queuedDispatcher.paint, queuedPaint);
    assert.equal(queuedPaint.waits, graph.waits);
    assert.equal(queuedPaint.initialized, graph.initialized);
    assert.equal(queuedPaint.device, graph.device);
    assert.equal(graph.device.canvas, graph.host.surface);
    assert.equal(graph.initialized.initialized, false);
    assert.equal(graph.device.isPresent(), false);

    graph.waits.register(child.state, 0xf);
    const waitDispatch = graph.waits.dispatch.bind(graph.waits);
    const observations = [];
    const lifecycleOrder = [];
    graph.waits.dispatch = (message, wParam, lParam) => {
      if (message === 0xf) {
        observations.push(['broadcast', messages.pending]);
        messages.invalidate('main'); // Repeated invalidation before validation joins this paint.
      }
      if (message === 0x10 || message === 2) lifecycleOrder.push(`main:${message}`);
      waitDispatch(message, wParam, lParam);
    };
    messages.invalidate('main');
    messages.invalidate('main');
    assert.equal(messages.pending, 1);
    const first = await queuedDispatcher.dispatchNext();
    assert.equal(first.event.kind, 'window');
    assert.equal(first.event.message.message, 0xf);
    assert.equal(messages.isGeneratedPaint(first.event.message), true);
    assert.equal(first.result, 0);
    assert.deepEqual(observations, [['broadcast', 0]]);
    assert.equal(graph.waits.consume(child.state, 0xf).received, true);
    assert.equal(messages.pending, 0);
    assert.deepEqual([...context.pixels], Array(8).fill(0xff000000));
    assert.deepEqual(context.calls, [
      'save',
      'resetTransform',
      ['alpha', 1],
      ['composite', 'copy'],
      ['fill', '#000000'],
      ['fillRect', 0, 0, 4, 2],
      'restore',
    ]);
    assert.equal(await queuedDispatcher.dispatchNext(), null);
    messages.invalidate('main'); // An invalidation after validation produces another paint.
    assert.equal(messages.pending, 1);
    const second = await queuedDispatcher.dispatchNext();
    assert.equal(second.event.message.message, 0xf);
    assert.equal(messages.pending, 0);
    assert.equal(graph.waits.consume(child.state, 0xf).received, true);

    const paintedNumeric = messages.createTarget();
    let numericPaintCount = 0;
    messages.bindQueuedNumericTarget(paintedNumeric, async ({message}) => {
      assert.equal(message, 0xf);
      numericPaintCount++;
      await Promise.resolve();
      if (numericPaintCount === 1) messages.invalidate(paintedNumeric);
      return true;
    });
    messages.invalidate(paintedNumeric);
    const numericPaint = await queuedDispatcher.dispatchNext();
    assert.equal(messages.isGeneratedPaint(numericPaint.event.message), true);
    assert.equal(messages.pending, 1);
    assert.equal((await queuedDispatcher.dispatchNext()).result, 1);
    assert.equal(numericPaintCount, 2);
    assert.equal(messages.pending, 0);
    messages.forgetTarget(paintedNumeric);

    const numeric = messages.createTarget();
    messages.bindQueuedNumericTarget(numeric, async ({message}) => {
      lifecycleOrder.push(`numeric:${message}`);
      return true;
    });
    messages.post({target: numeric, message: 0x9001, wParam: 7, lParam: 8});
    messages.post({target: 'main', message: 0x10, wParam: 0, lParam: 0});
    messages.post({target: 'main', message: 0xf, wParam: 0, lParam: 0});
    messages.post({target: numeric, message: 0x9002, wParam: 9, lParam: 10});
    assert.equal((await queuedDispatcher.dispatchNext()).result, 1);
    assert.equal(messages.mainTarget(), 'main');
    assert.equal((await queuedDispatcher.dispatchNext()).result, 0);
    assert.equal(messages.mainTarget(), null);
    const fillsBeforeStalePaint = context.calls.length;
    const broadcastsBeforeStalePaint = observations.length;
    assert.equal((await queuedDispatcher.dispatchNext()).result, 0);
    assert.equal(context.calls.length, fillsBeforeStalePaint);
    assert.equal(observations.length, broadcastsBeforeStalePaint);
    assert.equal((await queuedDispatcher.dispatchNext()).result, 1);
    const quit = await queuedDispatcher.dispatchNext();
    assert.deepEqual(quit, {event: {kind: 'quit', exitCode: 0}, result: -1});
    assert.deepEqual(lifecycleOrder, ['numeric:36865', 'main:16', 'main:2', 'numeric:36866']);
    messages.forgetTarget(numeric);
    graph.waits.unregister(child.state, 0xf);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});

test('graph shutdown joins an accepted numeric dispatch before main destruction', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, core} = fixture;
  let release;
  try {
    await core.close();
    const target = graph.messages.createTarget();
    const waiting = new Promise((resolve) => {
      release = resolve;
    });
    graph.messages.bindQueuedNumericTarget(target, async () => {
      await waiting;
      return true;
    });
    graph.messages.post({target, message: 0x9010, wParam: 0, lParam: 0});
    const dispatch = graph.queuedDispatcher.dispatchNext();
    assert.equal(graph.queuedDispatcher.hasPendingDispatch, true);
    const closing = graph.shutdown();
    assert.equal(graph.messages.mainTarget(), 'main');
    assert.equal(graph.host.surface.parent, graph.host.parent);
    release();
    assert.equal((await dispatch).result, 1);
    await closing;
    assert.equal(graph.messages.mainTarget(), null);
    assert.equal(graph.queuedDispatcher.hasPendingDispatch, false);
  } finally {
    release?.();
    await fixture.close();
  }
});
