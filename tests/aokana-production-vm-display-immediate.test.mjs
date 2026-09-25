import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM mutates a real Group and Sprite through immediate display callbacks', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, invoke} = fixture;
  try {
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => primary === 0x90 && secondary >= 0x30 && secondary <= 0x3a,
        )
        .map(({secondary}) => secondary),
      [0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a],
    );
    assert.equal(graph.manager.environment.damage, graph.damage);
    assert.equal(graph.surfaces.allocate(0, 4, 4, 2), 1);
    assert.equal(graph.surfaces.fill(0, 0xff204060), 1);
    assert.equal(await invoke(0x90, 0x50, [], 0), 1);
    const spriteHandle = pop32(child.state);
    assert.equal(await invoke(0x90, 0x56, [spriteHandle, 3, 4, 0, 0x80, 128, 7], 0), 0);
    const sprite = graph.manager.find('sprite', spriteHandle);
    assert.ok(sprite);
    assert.equal(await invoke(0x90, 0x50, [], 0), 1);
    const otherHandle = pop32(child.state);
    assert.equal(await invoke(0x90, 0x56, [otherHandle, 3, 4, 0, 0x80, 128, 9], 0), 0);
    const other = graph.manager.find('sprite', otherHandle);
    assert.ok(other);
    assert.equal(await invoke(0x90, 0xe0, [], 0), 1);
    const groupHandle = pop32(child.state);
    const group = graph.manager.find('group', groupHandle);
    assert.ok(group);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(await invoke(0x90, 0xe8, [groupHandle, spriteHandle, 2, 3], 0), 0);
    assert.equal(sprite.parent, group);
    assert.deepEqual(sprite.position(), {x: 2, y: 3});
    const call = async (secondary, args) => {
      assert.equal(await invoke(0x90, secondary, args, 0), 0);
      assert.equal(child.state.stackIndex, 0);
    };
    const orderedObjects = () =>
      graph.manager.lists
        .snapshot(false)
        .filter(({object}) => object === sprite || object === other)
        .map(({object}) => object.handle);
    assert.deepEqual(orderedObjects(), [spriteHandle, otherHandle]);

    await call(0x30, [groupHandle, 1]);
    assert.deepEqual([group.activation, sprite.activation], [1, 1]);
    graph.damage.clear();
    await call(0x33, [groupHandle, 20, 30]);
    assert.deepEqual(
      [group.position(), sprite.position()],
      [
        {x: 20, y: 30},
        {x: 22, y: 33},
      ],
    );
    assert.ok(graph.damage.snapshot().length > 0);
    await call(0x36, [groupHandle, -2, 3]);
    assert.deepEqual(
      [group.getSecondaryOffset(), sprite.getSecondaryOffset()],
      [
        {x: -2, y: 3},
        {x: -2, y: 3},
      ],
    );
    await call(0x37, [groupHandle, 4, -5]);
    assert.deepEqual(
      [group.getOffset(), sprite.getOffset()],
      [
        {x: 4, y: -5},
        {x: 4, y: -5},
      ],
    );
    await call(0x32, [groupHandle, 128]);
    assert.deepEqual([group.getBlendValue(), sprite.getBlendValue()], [128, 128]);
    await call(0x35, [groupHandle, 7]);
    assert.deepEqual([group.getValueD8(0), sprite.getValueD8(0)], [7, 7]);
    await call(0x34, [groupHandle, 256]);
    assert.deepEqual([group.inputActive(), sprite.inputActive()], [0, 0]);
    await call(0x34, [groupHandle, 0]);
    await call(0x39, [groupHandle, 64]);
    assert.deepEqual([group.opacityScale, sprite.opacityScale], [64, 64]);
    await call(0x38, [groupHandle, 0xc0, 1, 0]);
    assert.equal(group.propagateSecondaryVisibility, 1);
    await call(0x31, [groupHandle, 0]);
    assert.deepEqual([group.secondaryVisibility, sprite.secondaryVisibility], [0, 0]);
    await call(0x31, [groupHandle, 1]);
    assert.deepEqual([group.inputActive(), sprite.inputActive()], [1, 1]);
    await call(0x38, [spriteHandle, 0x8100, 256, 0]);
    assert.equal(sprite.sortBias, 256);
    assert.equal(
      graph.manager.lists.snapshot(false).find(({object}) => object === sprite).key,
      sprite.sortKey(),
    );
    await call(0x3a, [spriteHandle, 10]);
    assert.equal(sprite.getLayer(), 10);
    assert.deepEqual(orderedObjects(), [otherHandle, spriteHandle]);
    await call(0x30, [groupHandle, 0]);
    assert.deepEqual([group.inputActive(), sprite.inputActive()], [0, 0]);

    assert.equal(await invoke(0x90, 0xe9, [groupHandle, spriteHandle], 0), 0);
    assert.equal(sprite.parent, null);
    assert.equal(await invoke(0x90, 0xe1, [groupHandle], 0), 0);
    assert.equal(await invoke(0x90, 0x51, [spriteHandle], 0), 0);
    assert.equal(await invoke(0x90, 0x51, [otherHandle], 0), 0);
    assert.equal(graph.manager.find('group', groupHandle), null);
    assert.equal(graph.manager.find('sprite', spriteHandle), null);
    assert.equal(graph.manager.find('sprite', otherHandle), null);
    assert.equal(graph.surfaces.release(0), 1);
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});
