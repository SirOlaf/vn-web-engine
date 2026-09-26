import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted rain callbacks share graph display, random and timing owners', async () => {
  const fixture = await createMountedVmFixture({performanceNow: () => 100});
  const {graph, child, definitions, invoke} = fixture;
  const call = async (secondary, args) => {
    assert.equal(await invoke(0xc0, secondary, args, 0), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  };
  try {
    assert.equal(graph.rain.manager, graph.manager);
    assert.equal(graph.rain.state, graph.rainState);
    assert.equal(graph.rain.random, graph.particleRandom);
    assert.equal(graph.rain.ticks, graph.ticks);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => primary === 0xc0 && secondary >= 0x40 && secondary <= 0x4f,
        )
        .map(({secondary}) => secondary),
      Array.from({length: 16}, (_, index) => index + 0x40),
    );

    assert.equal(await invoke(0xc0, 0x40, [4, 2], 0), 1);
    const handle = pop32(child.state);
    assert.equal(handle, 0xc1000000);
    assert.equal(child.state.stackIndex, 0);
    const object = graph.rain.find(handle);
    assert.ok(object);
    assert.equal(graph.manager.find('rain', handle), object);
    assert.equal(graph.manager.categoryCount(7), 1);
    assert.equal(object.bitmap.width, 4);
    assert.equal(object.bitmap.height, 2);
    assert.equal(object.bitmap.format, 0);
    assert.equal(object.bitmap.bytesPerPixel, 2);
    assert.equal(object.rainBitmap.format, 0);
    assert.equal(object.rainBitmap.width, 4);
    assert.equal(object.rainBitmap.height, 2);

    await call(0x42, [handle, 1]);
    assert.equal(object.rain.previousTick, 99);
    assert.equal(await invoke(0x90, 0x11, [4, 4, 2, 3], 0), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(graph.surfaces.snapshot(4).format, 3);
    await call(0x43, [handle, 4]);
    assert.equal(object.maskHandle, 4);
    await call(0x43, [handle, 0xffffffff]);
    assert.equal(object.maskHandle, 0xffffffff);
    await call(0x44, [handle, 1]);
    assert.equal(object.activation, 1);
    await call(0x45, [handle, 4, 5, 0x20, 17, 2]);
    assert.deepEqual(object.position(), {x: 4, y: 5});
    assert.equal(object.blendMode, 0x20);
    assert.equal(object.blendValue, 17);
    assert.equal(object.layer, 2);
    assert.ok(graph.manager.lists.snapshot(false).some((entry) => entry.object === object));

    await call(0x46, [handle, 1, 2, 3, 4, 5, 6]);
    for (const [secondary, value] of [
      [0x47, 11],
      [0x48, 12],
      [0x49, 0x91234567],
      [0x4a, 13],
      [0x4b, 14],
      [0x4e, 15],
    ])
      await call(secondary, [handle, value]);
    await call(0x4c, [handle, 16, 17, 18]);
    await call(0x4d, [handle, 19, 20, 21]);
    assert.deepEqual(
      [...object.rain.parameters],
      [1, 2, 3, 4, 5, 6, 0, -1, 0, 11 << 8, 12 << 8, 0x91234567 | 0, 0, 13, 14, 1],
    );
    assert.deepEqual([...object.rain.transform], [16, 17, 18, 19, 20, 21, 15]);
    await call(0x4f, [1, 60]);
    assert.equal(graph.rainState.enabled, 1);
    assert.equal(graph.rainState.accumulatedMilliseconds, 0);
    assert.equal(graph.rainState.frameInterval, 16);
    assert.equal(graph.manager.redraw.pending, 1);
    await call(0x41, [handle]);
    assert.equal(graph.manager.find('rain', handle), null);
    assert.equal(graph.manager.categoryCount(7), 0);
    assert.equal(await invoke(0x90, 0x12, [4], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});
