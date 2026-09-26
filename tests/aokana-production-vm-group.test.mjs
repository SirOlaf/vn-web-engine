import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {BurikoDisplayGroup} from '../dist/engines/buriko/native/display-group.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM binds Group hierarchy to its graph and propagates display state', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, invoke} = fixture;
  try {
    assert.equal(graph.groups.manager, graph.manager);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => primary === 0x90 && secondary >= 0xe0 && secondary <= 0xe9,
        )
        .map(({secondary}) => secondary),
      [0xe0, 0xe1, 0xe4, 0xe5, 0xe8, 0xe9],
    );
    assert.equal(graph.surfaces.allocate(0, 4, 4, 2), 1);
    assert.equal(graph.surfaces.fill(0, 0xff204060), 1);
    assert.equal(await invoke(0x90, 0x50, [], 0), 1);
    const spriteHandle = pop32(child.state);
    assert.equal(await invoke(0x90, 0x56, [spriteHandle, 4, 4, 0, 0x80, 12, 7], 0), 0);
    const sprite = graph.manager.find('sprite', spriteHandle);
    assert.ok(sprite);
    assert.equal(await invoke(0x90, 0xe0, [], 0), 1);
    const groupHandle = pop32(child.state);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(groupHandle, 0xf1000000);
    const group = graph.manager.find('group', groupHandle);
    assert.ok(group instanceof BurikoDisplayGroup);
    assert.equal(graph.manager.categoryCount(0x11), 1);
    assert.equal(await invoke(0x90, 0xe8, [groupHandle, spriteHandle, 3, 5], 0), 0);
    assert.equal(sprite.parent, group);
    assert.deepEqual([...group.children()], [sprite]);
    assert.deepEqual(sprite.position(), {x: 3, y: 5});
    assert.equal(await invoke(0x90, 0xe4, [groupHandle, 1], 0), 0);
    assert.deepEqual([group.activation, sprite.activation], [1, 1]);
    graph.damage.clear();
    assert.equal(await invoke(0x90, 0xe5, [groupHandle, 10, 20, 64], 0), 0);
    assert.deepEqual(
      [group.position(), sprite.position()],
      [
        {x: 10, y: 20},
        {x: 13, y: 25},
      ],
    );
    assert.deepEqual([group.getBlendValue(), sprite.getBlendValue()], [64, 64]);
    assert.ok(graph.damage.snapshot().length > 0);
    assert.equal(await invoke(0x90, 0xe9, [groupHandle, spriteHandle], 0), 0);
    assert.equal(sprite.parent, null);
    assert.equal(await invoke(0x90, 0xe5, [groupHandle, 11, 21, 80], 0), 0);
    assert.deepEqual(sprite.position(), {x: 13, y: 25});
    assert.equal(sprite.getBlendValue(), 64);
    assert.equal(await invoke(0x90, 0xe1, [groupHandle], 0), 0);
    assert.equal(graph.manager.categoryCount(0x11), 0);
    assert.equal(await invoke(0x90, 0x51, [spriteHandle], 0), 0);
    assert.equal(graph.manager.find('sprite', spriteHandle), null);
    assert.equal(graph.surfaces.release(0), 1);
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});
