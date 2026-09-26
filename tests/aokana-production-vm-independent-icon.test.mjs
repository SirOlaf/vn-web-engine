import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {bitmapRead32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {BurikoWindowDisplayObject} from '../dist/engines/buriko/native/display-window.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted base Icon callbacks share Window, BP records and the core poll lane', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, data, core, child, definitions, invoke, memory} = fixture;
  const view = new DataView(memory.globalMemory.buffer);
  const words = (offset, values) =>
    values.forEach((value, index) => view.setInt32(offset + index * 4, value, true));
  const call = async (primary, secondary, args, pushed = 0) => {
    assert.equal(await invoke(primary, secondary, args, 0), pushed);
    assert.equal(child.process, null);
  };
  const result = async (primary, secondary, args) => {
    await call(primary, secondary, args, 1);
    const value = pop32(child.state);
    assert.equal(child.state.stackIndex, 0);
    return value;
  };
  try {
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) =>
            primary === 0x90 && (secondary === 0xb6 || (secondary >= 0xb8 && secondary <= 0xbf)),
        )
        .map(({secondary}) => secondary),
      [0xb6, 0xb8, 0xb9, 0xba, 0xbc, 0xbd, 0xbe, 0xbf],
    );
    assert.equal(data.procedures.manager, graph.manager);
    assert.equal(core.procedureState, data.procedureState);
    assert.equal(graph.cursorPolicy.manager, graph.manager);
    assert.equal(graph.cursorPolicy.input, graph.input);
    assert.equal(graph.cursorPolicy.clock, graph.clock);
    assert.equal(graph.cursorPolicy.physical, graph.cursor);
    assert.equal(graph.manager.configureDescriptor(64, 32, 1, 64 * 32), 1);
    assert.equal(graph.device.isPresent(), false);
    graph.display.requestedWidth = 800;
    graph.display.requestedHeight = 600;
    graph.display.refreshPointerStep();
    graph.input.foreground = true;
    graph.input.pointerAvailable = true;
    graph.input.pointerClientX = 2;
    graph.input.pointerClientY = 2;
    const windowHandle = await result(0x90, 0x80, [32, 32]);
    assert.equal(windowHandle, 0xb0000000);
    const window = graph.manager.find('window', windowHandle);
    assert.ok(window instanceof BurikoWindowDisplayObject);
    await call(0x90, 0x84, [windowHandle, 1]);
    for (const [id, color] of [
      [0, 0x110000],
      [1, 0x002200],
      [2, 0x000033],
    ]) {
      await call(0x90, 0x11, [id, 3, 2, 1]);
      await call(0x90, 0x13, [id, color]);
    }
    words(32, [1, 128, 0, 1, 0, 0, 0, 0]);
    words(128, [2, 256, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1]);
    for (const [index, x] of [
      [0, 2],
      [1, 8],
    ])
      words(256 + index * 60, [1, x, 2, 0, 1, 2, -1, 0, 0, -1, 0, 0, -1, 0, 0]);
    const pixel = (x, y) => {
      const bitmap = window.textBitmap;
      return bitmapRead32(bitmap, bitmap.offset + y * bitmap.stride + x * 4) & 0xffffff;
    };
    const captures = () => {
      const state = graph.input.captureDiagnosticView();
      return {
        pointer: state.pointer.map(({token}) => token),
        key: state.key.map(({token}) => token),
      };
    };
    const initialCaptures = captures();

    const id = await result(0x90, 0xb8, [windowHandle]);
    assert.equal(id, 1);
    assert.equal(window.getOwner(), data.procedures.find(id));
    assert.equal([...window.children()].length, 1);
    assert.equal(await result(0x90, 0xba, [id, 32]), 0);
    assert.equal([...window.children()].length, 3);
    assert.deepEqual([pixel(2, 2), pixel(8, 2)], [0x002200, 0x110000]);
    assert.deepEqual(
      [2, 8].map((x) => {
        const bitmap = window.compositionBitmap;
        return bitmapRead32(bitmap, bitmap.offset + 2 * bitmap.stride + x * 4) & 0xffffff;
      }),
      [0x002200, 0x110000],
    );

    words(0x400, [0x10000002, 0, 1]);
    assert.equal(await result(0x80, 0xac, [id, 3, 0x400]), 1);
    assert.equal(await core.runIndependentPoll('enabled'), 1);
    assert.deepEqual([pixel(2, 2), pixel(8, 2)], [0x000033, 0x002200]);
    memory.globalMemory.fill(0xcc, 0x500, 0x558);
    assert.equal(await result(0x90, 0xbd, [0x500, id]), 1);
    assert.equal(view.getInt32(0x500, true), 0);
    assert.equal(await result(0x90, 0xbe, [0x510, id]), 1);
    assert.equal(view.getInt32(0x510, true), 1);
    assert.equal(await result(0x90, 0xbf, [0x520, id]), 1);
    assert.deepEqual(
      [0, 1, 2].map((index) => view.getUint32(0x520 + index * 4, true)),
      [0x10000002, 0, 1],
    );

    words(0x400, [0x10000000, 1, 0]);
    assert.equal(await result(0x80, 0xac, [id, 3, 0x400]), 1);
    assert.equal(await core.runIndependentPoll('enabled'), 1);
    assert.equal(await result(0x90, 0xbc, [0x540, id]), 1);
    assert.deepEqual(
      Array.from({length: 6}, (_, index) => view.getInt32(0x540 + index * 4, true)),
      [0, 0, 1, 0, 0, 0],
    );
    assert.notDeepEqual(captures(), initialCaptures);
    assert.equal(await result(0x90, 0xb9, [id]), 1);
    assert.equal(data.procedures.find(id), null);
    assert.equal(window.getOwner(), null);
    assert.equal([...window.children()].length, 0);
    assert.deepEqual(captures(), initialCaptures);
    assert.equal(data.procedures.hasActivePoll, false);
    assert.equal(child.state.stackIndex, 0);
    await call(0x90, 0x81, [windowHandle]);
    for (const surface of [2, 1, 0]) assert.equal(await result(0x90, 0x12, [surface]), 1);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});
