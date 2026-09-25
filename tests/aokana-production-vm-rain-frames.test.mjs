import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted RainFrames updates and refreshes the bound rain display on explicit frame calls', async () => {
  let now = 0;
  const fixture = await createMountedVmFixture({performanceNow: () => now});
  const {graph, child, invoke} = fixture;
  const call = async (secondary, args, pushed = 0) => {
    assert.equal(await invoke(0xc0, secondary, args, 0), pushed);
    assert.equal(child.state.stackIndex, pushed);
    assert.equal(child.process, null);
  };
  try {
    assert.equal(graph.rainFrames.rain, graph.rain);
    assert.equal(graph.rainFrames.clock, graph.clock);
    assert.equal(graph.rain.manager, graph.manager);
    assert.equal(graph.device.isPresent(), false);
    await call(0x40, [4, 2], 1);
    const handle = pop32(child.state);
    assert.equal(handle, 0xc1000000);
    const object = graph.rain.find(handle);
    assert.ok(object);
    assert.equal(graph.manager.find('rain', handle), object);
    assert.equal(child.state.stackIndex, 0);
    await call(0x42, [handle, 0]);
    assert.equal(object.rain.previousTick, 0);
    await call(0x4f, [1, 60]);
    assert.equal(graph.rainState.enabled, 1);
    assert.equal(graph.rainState.frameInterval, 16);
    assert.equal(graph.rainState.accumulatedMilliseconds, 0);

    const redrawModes = [];
    const redraw = graph.manager.redraw;
    const originalRequest = redraw.request;
    redraw.request = function (mode) {
      redrawModes.push(mode);
      return originalRequest.call(this, mode);
    };
    try {
      object.rainBitmap.storage.bytes.fill(0x7f);
      graph.rainFrames.updateAll();
      assert.equal(object.rain.previousTick, 0);
      graph.rainFrames.pollRefresh();
      assert.ok(object.rainBitmap.storage.bytes.every((value) => value === 0));
      assert.equal(graph.rainState.accumulatedMilliseconds, 16);
      assert.deepEqual(redrawModes, [0]);
      assert.equal(redraw.pending, 1);

      now = 15;
      graph.rainFrames.pollRefresh();
      assert.equal(graph.rainState.accumulatedMilliseconds, 16);
      assert.deepEqual(redrawModes, [0]);
      now = 48;
      graph.rainFrames.pollRefresh();
      assert.equal(graph.rainState.accumulatedMilliseconds, 64);
      assert.deepEqual(redrawModes, [0, 0]);
      now = 64;
      graph.rainFrames.updateAll();
      assert.equal(object.rain.previousTick, 50);
      await call(0x41, [handle]);
      assert.equal(graph.rain.find(handle), null);
      assert.equal(graph.manager.categoryCount(7), 0);
      graph.rainFrames.pollRefresh();
      assert.equal(graph.rainState.accumulatedMilliseconds, 80);
      assert.deepEqual(redrawModes, [0, 0]);
    } finally {
      redraw.request = originalRequest;
    }
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});
