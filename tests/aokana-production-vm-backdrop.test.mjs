import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM binds backdrop layers to its graph surfaces', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, invoke} = fixture;
  try {
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => primary === 0x90 && secondary >= 0x45 && secondary <= 0x4d,
        )
        .map(({secondary}) => secondary),
      [0x45, 0x4c, 0x4d, 0x4a, 0x48, 0x49, 0x47, 0x46],
    );
    assert.equal(await invoke(0x90, 0x4d, [], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(graph.surfaces.allocate(0, 2, 1, 1), 1);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => primary === 0x91 && secondary >= 0x40 && secondary <= 0x4a,
        )
        .map(({secondary}) => secondary),
      [0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a],
    );
    const callLayer = async (secondary, args) => {
      assert.equal(await invoke(0x91, secondary, args, 0), 0);
    };
    await callLayer(0x40, [0, 0, 0, 0, 0, 0, 65536, 65536, 0]);
    assert.equal(graph.manager.backdrop.backdropType, 12);
    assert.equal(await invoke(0x90, 0x4d, [], 0), 1);
    assert.equal(pop32(child.state), 12);
    graph.damage.clear();
    assert.equal(await invoke(0x90, 0x4c, [1, 1], 0), 0);
    assert.equal(graph.manager.backdrop.activation, 1);
    assert.equal(graph.manager.backdropContentEnabled, 1);
    assert.equal(graph.damage.fullRedraw, 1);
    await callLayer(0x41, [1]);
    await callLayer(0x42, [1, 1]);
    await callLayer(0x43, [1, 2 << 16, 3 << 16]);
    await callLayer(0x44, [1, 0x20]);
    await callLayer(0x45, [1, 128]);
    await callLayer(0x46, [1, 0, 4 << 16, 5 << 16]);
    await callLayer(0x47, [1, 0, 65536, 65536, 0]);
    await callLayer(0x48, [1, 7, 9]);
    await callLayer(0x49, [1, 11, 13]);
    await callLayer(0x4a, [1, 17, 19, 23]);
    const multilayer = graph.manager.backdrop;
    assert.equal(multilayer.layerActivation(1), 1);
    assert.deepEqual(multilayer.position(), {x: 2 << 16, y: 3 << 16});
    assert.equal(multilayer.getBlendValue(), 128);
    assert.deepEqual(
      [...multilayer.layers[1]],
      [
        1,
        1,
        2 << 16,
        3 << 16,
        0x20,
        128,
        0,
        graph.surfaces.imageId(0),
        4 << 16,
        5 << 16,
        0,
        65536,
        65536,
        0,
        7,
        9,
        11,
        13,
        17,
        19,
        23,
        0,
      ],
    );
    graph.manager.selectBackdrop(1);
    assert.equal(graph.surfaces.release(0), 1);
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});
