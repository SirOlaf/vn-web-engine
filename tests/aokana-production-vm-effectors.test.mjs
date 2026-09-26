import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaDisplayEffector} from '../dist/engines/buriko/games/aokana/native/display-effector.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM effector callbacks share the manager pool, ordered list, and linked registry', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, fragments, invoke} = fixture;
  try {
    assert.equal(graph.filterDisplays.manager, graph.manager);
    assert.equal(graph.manager.environment.damage, graph.damage);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) =>
            primary === 0x91 &&
            [0x60, 0x61, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0x60, 0x61, 0x64, 0x66, 0x68, 0x69],
    );
    assert.equal(fragments.nativeDefinitions().length, definitions.length);

    assert.equal(await invoke(0x91, 0x60, [], 0), 1);
    const firstHandle = pop32(child.state);
    assert.equal(await invoke(0x91, 0x60, [], 0), 1);
    const secondHandle = pop32(child.state);
    assert.deepEqual([firstHandle, secondHandle], [0x91000000, 0x91000001]);
    assert.equal(graph.manager.categoryCount(2), 2);
    const first = graph.manager.find('effector', firstHandle);
    const second = graph.manager.find('effector', secondHandle);
    assert.ok(first instanceof AokanaDisplayEffector);
    assert.ok(second instanceof AokanaDisplayEffector);
    assert.equal(first.surfaces, graph.surfaces);
    assert.equal(second.surfaces, graph.surfaces);
    assert.equal(first.registry, graph.manager.effectors);
    assert.equal(second.registry, graph.manager.effectors);
    assert.equal(graph.manager.effectors.first.object, second);
    assert.equal(graph.manager.effectors.first.next.object, first);
    const ordered = () =>
      graph.manager.lists
        .snapshot(false)
        .filter(({object}) => object === first || object === second);
    assert.deepEqual(
      ordered().map(({object}) => object),
      [first, second],
    );
    assert.equal(graph.manager.effectors.hasVisible(), false);
    assert.equal(graph.manager.effectors.permitsDistributedDraw(), true);

    assert.equal(await invoke(0x91, 0x66, [firstHandle, 5, 0x80, 6], 0), 0);
    assert.equal(await invoke(0x91, 0x66, [secondHandle, 0, 0x40, 2], 0), 0);
    assert.deepEqual(
      [first.effectorMode, first.blurSelector, first.getBlendValue(), first.getLayer()],
      [1, 5, 0x80, 6],
    );
    assert.deepEqual(
      [second.effectorMode, second.blurSelector, second.getBlendValue(), second.getLayer()],
      [1, 0, 0x40, 2],
    );
    assert.deepEqual(
      ordered().map(({object}) => object),
      [second, first],
    );
    assert.deepEqual(
      ordered().map(({key}) => key),
      [second.sortKey(), first.sortKey()],
    );

    graph.damage.clear();
    assert.equal(await invoke(0x91, 0x64, [firstHandle, 1], 0), 0);
    assert.equal(graph.damage.fullRedraw, 1);
    assert.equal(graph.manager.effectors.hasVisible(), true);
    assert.equal(graph.manager.effectors.permitsDistributedDraw(), false);
    graph.damage.clear();
    assert.equal(await invoke(0x91, 0x64, [secondHandle, 1], 0), 0);
    assert.equal(graph.damage.fullRedraw, 1);
    assert.deepEqual([first.activation, second.activation], [1, 1]);

    graph.damage.clear();
    assert.equal(
      await invoke(0x91, 0x68, [firstHandle, 3, 4, 0x2000, 0x18000, 0xc000, 0x20, 0x100, 8], 0),
      0,
    );
    assert.equal(graph.damage.fullRedraw, 1);
    assert.deepEqual(
      [
        first.effectorMode,
        first.basePivotX,
        first.basePivotY,
        first.baseAngle,
        first.baseScaleX,
        first.baseScaleY,
        first.transformTransparency,
        first.getLayer(),
      ],
      [3, 3, 4, 0x2000, 0x18000, 0xc000, 0x20, 8],
    );
    graph.damage.clear();
    assert.equal(await invoke(0x91, 0x69, [firstHandle, 0xc0, 9], 0), 0);
    assert.equal(graph.damage.fullRedraw, 1);
    assert.deepEqual([first.effectorMode, first.getBlendValue(), first.getLayer()], [4, 0xc0, 9]);
    assert.equal(graph.manager.effectors.permitsDistributedDraw(), false);

    graph.damage.clear();
    assert.equal(await invoke(0x91, 0x64, [secondHandle, 0], 0), 0);
    assert.equal(graph.damage.fullRedraw, 1);
    assert.equal(graph.manager.effectors.hasVisible(), true);
    assert.equal(graph.manager.effectors.permitsDistributedDraw(), true);
    graph.damage.clear();
    assert.equal(await invoke(0x91, 0x61, [firstHandle], 0), 0);
    assert.equal(graph.damage.fullRedraw, 1);
    assert.equal(graph.manager.effectors.hasVisible(), false);
    assert.equal(graph.manager.effectors.first.object, second);
    assert.equal(graph.manager.effectors.first.next, null);
    graph.damage.clear();
    assert.equal(await invoke(0x91, 0x61, [secondHandle], 0), 0);
    assert.equal(graph.damage.fullRedraw, 0);
    assert.deepEqual(
      [graph.manager.find('effector', firstHandle), graph.manager.find('effector', secondHandle)],
      [null, null],
    );
    assert.equal(graph.manager.categoryCount(2), 0);
    assert.equal(graph.manager.effectors.first, null);
    assert.deepEqual(ordered(), []);
    assert.equal(graph.manager.effectors.hasVisible(), false);
    assert.equal(graph.manager.effectors.permitsDistributedDraw(), true);
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});
