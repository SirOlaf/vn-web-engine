import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {bitmapRead32} from '../dist/engines/buriko/games/aokana/native/bitmap-scalar.js';
import {AokanaWindowDisplayObject} from '../dist/engines/buriko/games/aokana/native/display-window.js';
import {AokanaIndependentIconState} from '../dist/engines/buriko/games/aokana/native/independent-icon.js';
import {AokanaNativeSplines} from '../dist/engines/buriko/games/aokana/native/spline-registry.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted IconEEx moves Window children along the shared spline registry', async () => {
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
    assert.ok(data.independentIcon instanceof AokanaIndependentIconState);
    assert.ok(data.splines instanceof AokanaNativeSplines);
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
    graph.input.pointerClientX = 22;
    graph.input.pointerClientY = 4;

    const windowHandle = await result(0x90, 0x80, [32, 32]);
    const window = graph.manager.find('window', windowHandle);
    assert.ok(window instanceof AokanaWindowDisplayObject);
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
    words(32, [1, 128, 0, 1, 0, 0, 4, 0, 0, 0]);
    words(128, [2, 2, 256, 0, 0, 1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0]);
    for (let index = 0; index < 2; index++) {
      const unit = new Array(49).fill(0);
      unit[0] = unit[1] = 1;
      unit[2] = index === 0 ? 2 : 20;
      unit[3] = 3;
      unit[4] = unit[5] = 1;
      unit[6] = 1;
      unit[7] = 0;
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

    const map = new Array(24).fill(0);
    map[12] = 6;
    words(0x320, map);
    await call(0x91, 0xbf, [4, 0x320]);
    const id = await result(0x91, 0xbc, [windowHandle]);
    assert.equal(id, 1);
    assert.equal(window.getOwner(), data.procedures.find(id));
    assert.equal(await result(0x91, 0xba, [id, 32]), 0);
    assert.equal([...window.children()].length, 3);
    assert.equal(await core.runIndependentPoll('enabled'), 1);
    assert.deepEqual([pixel(2, 3), pixel(20, 3)], [0xff0000, 0x202020]);

    words(0x2a0, [2, 3, 0, 0, 10, 3, 0, 0]);
    assert.equal(await result(0x91, 0xbd, [id, 0, 0, 2, 0x2a0, 0, 0, 0, 0, 100, 1]), 0);
    words(0x500, [0x30000000, 0, 0, 0, 0]);
    assert.equal(await result(0x80, 0xac, [id, 5, 0x500]), 1);
    assert.equal(await core.runIndependentPoll('enabled'), 1);
    now = 150;
    assert.equal(await core.runIndependentPoll('enabled'), 1);
    assert.deepEqual([pixel(2, 3), pixel(6, 3), pixel(20, 3)], [0, 0xff0000, 0x202020]);
    now = 200;
    assert.equal(await core.runIndependentPoll('enabled'), 1);
    assert.deepEqual([pixel(6, 3), pixel(10, 3), pixel(20, 3)], [0, 0xff0000, 0x202020]);
    assert.equal(await result(0x91, 0xbb, [id, 0, 0, 0]), 0);
    assert.equal(pixel(10, 3), 0);
    assert.equal(await result(0x91, 0xbb, [id, 0, 0, 1]), 0);
    assert.equal(pixel(10, 3), 0xff0000);

    graph.input.recordKeyDown(39);
    assert.equal(await core.runIndependentPoll('enabled'), 1);
    memory.globalMemory.fill(0xcc, 0x700, 0x708);
    assert.equal(await result(0x90, 0xbe, [0x700, id]), 1);
    assert.equal(view.getInt32(0x700, true), 1);
    assert.deepEqual(
      Array.from(memory.globalMemory.subarray(0x704, 0x708)),
      [0xcc, 0xcc, 0xcc, 0xcc],
    );
    assert.equal(pixel(20, 3), 0x00ff00);
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
