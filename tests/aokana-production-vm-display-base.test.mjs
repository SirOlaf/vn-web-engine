import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM display-base controls mutate its shared graph owners', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, memory, invoke} = fixture;
  try {
    assert.equal(graph.frames.manager, graph.manager);
    assert.equal(graph.frames.device, graph.device);
    assert.equal(graph.frames.clock, graph.clock);
    assert.equal(graph.manager.displayState, graph.display);
    assert.equal(graph.windowState.manager, graph.manager);
    assert.equal(graph.bitmapLoading.resources, graph.resource.loading);
    const selected = [0x00, 0x01, 0x02, 0x03, 0x06, 0x08, 0x09, 0x0a, 0x0c, 0x0f];
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x90 && selected.includes(secondary))
        .map(({secondary}) => secondary),
      selected,
    );
    for (const secondary of [0x04, 0x05, 0x0e])
      assert.equal(
        definitions.some(({primary, secondary: found}) => primary === 0x90 && found === secondary),
        false,
      );
    const call = async (secondary, args) => {
      assert.equal(await invoke(0x90, secondary, args, 0), 0);
      assert.equal(child.state.stackIndex, 0);
    };

    await call(0x00, [0]);
    assert.deepEqual([graph.manager.redraw.pending, graph.manager.redraw.mode], [1, 0]);
    await call(0x00, [9]);
    assert.deepEqual([graph.manager.redraw.pending, graph.manager.redraw.mode], [1, 1]);
    await call(0x01, [7]);
    assert.equal(graph.display.presentationEnabled, 7);
    await call(0x02, [25]);
    assert.deepEqual([graph.display.frameInterval, graph.display.frameDeadline], [40, 0]);
    await call(0x03, [4096]);
    assert.equal(graph.resource.loading.cache.capacity, 4096);
    assert.equal(graph.bitmapLoading.resources.cache.capacity, 4096);

    graph.damage.clear();
    await call(0x06, [13, 17]);
    assert.deepEqual(graph.manager.referencePoint, {x: 13, y: 17});
    assert.equal(graph.damage.fullRedraw, 1);
    graph.damage.clear();
    await call(0x08, [0x12345678]);
    assert.equal(graph.damage.fullRedraw, 1);
    graph.damage.clear();
    await call(0x09, [27]);
    assert.equal(graph.manager.minimumKey, 27 << 16);
    assert.equal(graph.damage.fullRedraw, 1);
    await call(0x0a, [5, 6]);
    assert.deepEqual(
      [graph.manager.redraw.automaticEnabled, graph.manager.redraw.automaticMode],
      [5, 6],
    );

    assert.equal(await invoke(0x90, 0x80, [4, 2], 0), 1);
    const windowHandle = pop32(child.state);
    const windowObject = graph.manager.find('window', windowHandle);
    assert.ok(windowObject);
    await call(0x84, [windowHandle, 1]);
    graph.damage.clear();
    await call(0x0c, [3, 192]);
    assert.deepEqual([graph.windowState.enabled, graph.windowState.transparency], [3, 192]);
    assert.ok(graph.damage.snapshot().some(({key}) => key === windowObject.sortKey()));
    await call(0x81, [windowHandle]);
    assert.equal(graph.manager.find('window', windowHandle), null);

    await call(0x0f, [0x204060]);
    assert.equal(graph.compositor.importMatteColor, 0x204060);
    new DataView(memory.globalMemory.buffer).setUint32(0x240, 0x80323c50, true);
    await call(0x14, [2, 1, 1, 2, 0x240]);
    assert.equal(graph.surfaces.snapshot(2).storage.view.getUint32(0, true), 0x80453941);
    assert.equal(await invoke(0x90, 0x12, [2], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});
