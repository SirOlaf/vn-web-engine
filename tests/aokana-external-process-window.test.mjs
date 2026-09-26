import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoExternalProcessWindow} from '../dist/engines/buriko/native/external-process-window.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('external process window pumps the shared queued main and numeric targets', async () => {
  const painted = [];
  const fixture = await createMountedVmFixture({
    canvas2dContext: {
      save() {},
      resetTransform() {},
      restore() {},
      set globalAlpha(_) {},
      set globalCompositeOperation(_) {},
      set fillStyle(_) {},
      fillRect(...rectangle) {
        painted.push(rectangle);
      },
    },
  });
  const {graph} = fixture;
  try {
    const window = new BurikoExternalProcessWindow(graph.showState, graph.queuedDispatcher);
    const received = [];
    const numeric = graph.messages.createTarget();
    graph.messages.bindQueuedNumericTarget(numeric, (message) => {
      received.push(message.message);
      return true;
    });
    graph.messages.post({target: numeric, message: 0x9001, wParam: 0, lParam: 0});
    graph.waits.register(fixture.core.root, 0x102);
    graph.keyboard.post('main', {
      type: 'keydown',
      code: 'KeyA',
      keyCode: 65,
      key: 'a',
      repeat: false,
      getModifierState: () => false,
    });
    graph.messages.invalidate('main');
    assert.equal(await window.pumpMessages(), 4);
    assert.deepEqual(received, [0x9001]);
    assert.equal(graph.waits.consume(fixture.core.root, 0x102)?.value1, 97n);
    assert.equal(painted.length, 1);
    assert.equal(graph.messages.pending, 0);

    await window.setShowState(0);
    assert.equal(window.readShowState(), 0);
    assert.equal(graph.host.parent.style.visibility, 'hidden');
    graph.messages.postQuit(7);
    assert.equal(await window.pumpMessages(), -1);
    graph.messages.forgetTarget(numeric);
  } finally {
    await fixture.close();
  }
});
