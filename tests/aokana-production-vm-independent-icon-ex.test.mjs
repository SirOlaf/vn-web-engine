import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {bitmapRead32} from '../dist/engines/buriko/native/bitmap-scalar.js';
import {BurikoWindowDisplayObject} from '../dist/engines/buriko/native/display-window.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted IconEx configures Window children and polls queued independent messages', async () => {
  let now = 100;
  const fixture = await createMountedVmFixture({performanceNow: () => now});
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
          ({primary, secondary}) => primary === 0x91 && secondary >= 0xb8 && secondary <= 0xbf,
        )
        .map(({secondary}) => secondary),
      [0xb8, 0xba, 0xbb, 0xbc, 0xbd, 0xbf],
    );
    assert.equal(data.procedures.manager, graph.manager);
    assert.equal(core.procedureState, data.procedureState);
    assert.equal(graph.cursorPolicy.manager, graph.manager);
    assert.equal(graph.cursorPolicy.input, graph.input);
    assert.equal(graph.cursorPolicy.clock, graph.clock);
    assert.equal(graph.cursorPolicy.physical, graph.cursor);
    assert.equal(graph.resource.errors.files, graph.resource.files);
    assert.equal(graph.manager.configureDescriptor(64, 32, 1, 64 * 32), 1);
    assert.equal(graph.device.isPresent(), false);
    graph.display.requestedWidth = 800;
    graph.display.requestedHeight = 600;
    graph.display.refreshPointerStep();
    graph.input.foreground = true;
    graph.input.pointerAvailable = true;
    graph.input.pointerClientX = 3;
    graph.input.pointerClientY = 4;

    const windowHandle = await result(0x90, 0x80, [32, 32]);
    const window = graph.manager.find('window', windowHandle);
    assert.ok(window instanceof BurikoWindowDisplayObject);
    await call(0x90, 0x84, [windowHandle, 1]);
    for (const [id, color] of [
      [0, 0xff0000],
      [1, 0x0000ff],
      [2, 0x202020],
      [3, 0x00ff00],
    ]) {
      await call(0x90, 0x11, [id, 4, 4, 1]);
      await call(0x90, 0x13, [id, color]);
    }

    // VM group header, sixteen-DWORD group, and two forty-nine-DWORD units.
    words(32, [1, 128, 0, 1, 0, 0, 0, 0, 0, 0]);
    words(128, [2, 2, 256, -1, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0]);
    for (let index = 0; index < 2; index++) {
      const unit = new Array(49).fill(0);
      unit[0] = unit[1] = 1;
      unit[2] = index === 0 ? 2 : 10;
      unit[3] = 3;
      unit[4] = unit[5] = 1;
      unit[6] = index === 0 ? 2 : 1;
      unit[7] = index === 0 ? 10 : 0;
      unit[8] = index === 0 ? 0 : 2;
      unit[9] = -1;
      unit[10] = index === 0 ? -1 : 3;
      unit[11] = unit[12] = unit[44] = unit[47] = -1;
      words(256 + index * 196, unit);
    }
    const pixel = (x, y) => {
      const bitmap = window.compositionBitmap;
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

    const id = await result(0x91, 0xb8, [windowHandle]);
    assert.equal(id, 1);
    assert.equal(window.getOwner(), data.procedures.find(id));
    assert.equal(await result(0x91, 0xba, [id, 32]), 0);
    assert.equal([...window.children()].length, 3);
    assert.deepEqual([pixel(2, 3), pixel(10, 3)], [0xff0000, 0x202020]);
    assert.equal(await core.runIndependentPoll('enabled'), 1);
    now = 111;
    assert.equal(await core.runIndependentPoll('enabled'), 1);
    assert.equal(pixel(2, 3), 0x0000ff);

    words(0x500, [0x10000002, 0, 1]);
    assert.equal(await result(0x80, 0xac, [id, 3, 0x500]), 1);
    assert.equal(await core.runIndependentPoll('enabled'), 1);
    assert.deepEqual([pixel(2, 3), pixel(10, 3)], [0x0000ff, 0x00ff00]);
    words(0x500, [0x10000007, 0, 1, 16, 3, 0]);
    assert.equal(await result(0x80, 0xac, [id, 6, 0x500]), 1);
    assert.equal(await core.runIndependentPoll('enabled'), 1);
    assert.deepEqual([pixel(10, 3), pixel(16, 3)], [0, 0x00ff00]);

    memory.globalMemory.fill(0xcc, 0x700, 0x708);
    assert.equal(await result(0x90, 0xbe, [0x700, id]), 1);
    assert.equal(view.getInt32(0x700, true), 1);
    assert.deepEqual(
      Array.from(memory.globalMemory.subarray(0x704, 0x708)),
      [0xcc, 0xcc, 0xcc, 0xcc],
    );
    assert.notDeepEqual(captures(), initialCaptures);
    assert.equal(await result(0x90, 0xb9, [id]), 1);
    assert.equal(data.procedures.find(id), null);
    assert.equal(window.getOwner(), null);
    assert.equal([...window.children()].length, 0);
    assert.deepEqual(captures(), initialCaptures);
    await call(0x90, 0x81, [windowHandle]);
    for (const surface of [3, 2, 1, 0]) assert.equal(await result(0x90, 0x12, [surface]), 1);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    assert.equal(data.procedures.hasActivePoll, false);
  } finally {
    await fixture.close();
  }
});
