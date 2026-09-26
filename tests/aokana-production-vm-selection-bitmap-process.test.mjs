import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {bitmapRead32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {AokanaWindowDisplayObject} from '../dist/engines/buriko/games/aokana/native/display-window.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted scheduled bitmap selectors share Window pixels, input and BP completion', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, data, core, child, definitions, invoke, memory} = fixture;
  const view = new DataView(memory.globalMemory.buffer);
  const words = (offset, values) =>
    values.forEach((value, index) => view.setInt32(offset + index * 4, value, true));
  const call = async (secondary, args, depth = 0, status = 0) => {
    assert.equal(await invoke(0x90, secondary, args, status), depth);
  };
  const result = async (secondary, args) => {
    await call(secondary, args, 1);
    const value = pop32(child.state);
    assert.equal(child.state.stackIndex, 0);
    return value;
  };
  const captures = () => {
    const state = graph.input.captureDiagnosticView();
    return {
      pointer: state.pointer.map(({token}) => token),
      key: state.key.map(({token}) => token),
    };
  };
  try {
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => primary === 0x90 && [0xaf, 0xb0, 0xb1].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0xaf, 0xb0, 0xb1],
    );
    assert.equal(core.procedureState, data.procedureState);
    assert.equal(graph.receiver.waits, graph.waits);
    assert.equal(graph.receiver.notifications, graph.notifications);
    assert.equal(graph.controller.notifications, graph.notifications);
    assert.equal(graph.windowState.manager, graph.manager);
    assert.equal(graph.manager.surfaces, graph.surfaces);
    assert.equal(graph.resource.errors.files.text, graph.text);
    assert.equal(graph.manager.configureDescriptor(64, 32, 1, 64 * 32), 1);
    assert.equal(graph.device.isPresent(), false);
    graph.display.requestedWidth = 800;
    graph.display.requestedHeight = 600;
    graph.display.refreshPointerStep();
    graph.input.foreground = true;
    graph.input.pointerAvailable = true;
    graph.input.pointerClientX = 3;
    graph.input.pointerClientY = 4;

    const handle = await result(0x80, [32, 32]);
    const window = graph.manager.find('window', handle);
    assert.ok(window instanceof AokanaWindowDisplayObject);
    await call(0x84, [handle, 1]);
    for (const [id, color] of [
      [0, 0xff0000],
      [1, 0x00ff00],
      [2, 0x0000ff],
      [3, 0x808080],
    ]) {
      await call(0x11, [id, 4, 4, 1]);
      await call(0x13, [id, color]);
    }
    const pixel = (x, y) => {
      const bitmap = window.compositionBitmap;
      return bitmapRead32(bitmap, bitmap.offset + y * bitmap.stride + x * 4) & 0xffffff;
    };
    const initialCaptures = captures();

    words(0x100, [2, 3, 0, 1, 10, 3, 2, 3]);
    await call(0xaf, [1]);
    assert.deepEqual(
      [
        data.bitmapSelection.foregroundOnly,
        data.textSelection.foregroundOnly,
        data.independentIcon.foregroundOnly,
      ],
      [1, 1, 1],
    );
    graph.input.foreground = false;
    await call(0xb0, [handle, 2, 0x100, 0, 3, 1, 0], 0, 2);
    assert.ok(child.process);
    assert.equal([...window.children()].length, 2);
    assert.equal(await child.pollProcess(false), 0);
    assert.deepEqual([pixel(2, 3), pixel(10, 3)], [0xff0000, 0x0000ff]);
    assert.equal(graph.notifications.take(), null);
    await call(0xaf, [0]);
    assert.deepEqual(
      [
        data.bitmapSelection.foregroundOnly,
        data.textSelection.foregroundOnly,
        data.independentIcon.foregroundOnly,
      ],
      [0, 0, 0],
    );
    assert.equal(await child.pollProcess(false), 0);
    assert.deepEqual([pixel(2, 3), pixel(10, 3)], [0x00ff00, 0x0000ff]);
    assert.deepEqual(graph.notifications.take(), {
      type: 0x20000001,
      value1: child.state.id,
      value2: 0x10000,
    });
    graph.input.foreground = true;
    await call(0xaf, [1]);
    graph.input.pointerClientX = 11;
    graph.input.pointerClientY = 4;
    graph.waits.dispatch(0x200, 0n, 0n);
    assert.equal(await child.pollProcess(false), 0);
    assert.deepEqual([pixel(2, 3), pixel(10, 3)], [0xff0000, 0x808080]);
    assert.deepEqual(graph.notifications.take(), {
      type: 0x20000001,
      value1: child.state.id,
      value2: 0x10001,
    });
    graph.input.recordKeyDown(1);
    assert.equal(await child.pollProcess(false), 1);
    assert.deepEqual([pop32(child.state), pop32(child.state), pop32(child.state)], [1, 1, 1]);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    assert.equal([...window.children()].length, 0);
    assert.deepEqual(captures(), initialCaptures);
    assert.equal(graph.waits.consume(child.state, 0x200), null);

    words(0x200, [2, 3, 0, 4, 5, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1, -1]);
    words(0x240, [20, 16, 2, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, 0, 0, -1]);
    words(0x300, [0xc1, 0xc2]);
    graph.input.pointerClientX = 3;
    graph.input.pointerClientY = 4;
    await call(0xb1, [handle, 2, 0x200, 0x300, 3, 1, 0], 0, 2);
    assert.ok(child.process);
    assert.equal(await child.pollProcess(false), 0);
    assert.deepEqual(window.overlayRectangle(0), {left: 4, top: 5, right: 7, bottom: 8});
    assert.equal(pixel(4, 5), 0x00ff00);
    assert.deepEqual(graph.notifications.take(), {
      type: 0x20000001,
      value1: child.state.id,
      value2: 0x10000,
    });
    graph.input.recordKeyDown(13);
    assert.equal(await child.pollProcess(false), 1);
    assert.deepEqual([pop32(child.state), pop32(child.state), pop32(child.state)], [0, 0, 0]);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    assert.equal([...window.children()].length, 0);
    assert.deepEqual(captures(), initialCaptures);
    assert.equal(graph.waits.consume(child.state, 0x200), null);

    await call(0xaf, [0]);
    await call(0x81, [handle]);
    assert.equal(graph.manager.find('window', handle), null);
    for (const id of [3, 2, 1, 0]) assert.equal(await result(0x12, [id]), 1);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});
