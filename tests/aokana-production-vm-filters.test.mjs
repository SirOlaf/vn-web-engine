import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaDisplayFilter} from '../dist/engines/buriko/games/aokana/native/display-filter.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM filter callbacks share the graph manager pool and ordered display list', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, fragments, invoke} = fixture;
  try {
    assert.equal(graph.filterDisplays.manager, graph.manager);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) =>
            primary === 0x90 && [0x60, 0x61, 0x64, 0x65, 0x66].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0x60, 0x61, 0x64, 0x65],
    );
    assert.equal(fragments.nativeDefinitions().length, definitions.length);
    graph.damage.clear();
    assert.equal(await invoke(0x90, 0x60, [], 0), 1);
    const firstHandle = pop32(child.state);
    assert.equal(await invoke(0x90, 0x60, [], 0), 1);
    const secondHandle = pop32(child.state);
    assert.deepEqual([firstHandle, secondHandle], [0x90000000, 0x90000001]);
    const first = graph.manager.find('filter', firstHandle);
    const second = graph.manager.find('filter', secondHandle);
    assert.ok(first instanceof AokanaDisplayFilter);
    assert.ok(second instanceof AokanaDisplayFilter);
    assert.equal(graph.manager.categoryCount(1), 2);
    assert.equal(first.surfaces, graph.surfaces);
    assert.equal(second.surfaces, graph.surfaces);
    assert.deepEqual(
      graph.manager.lists
        .snapshot(false)
        .filter(({object}) => object === first || object === second)
        .map(({object}) => object),
      [first, second],
    );

    assert.equal(await invoke(0x90, 0x65, [firstHandle, 0x304050, 0x80, 5], 0), 0);
    assert.equal(await invoke(0x90, 0x65, [secondHandle, 0x102030, 0x40, 2], 0), 0);
    assert.deepEqual(
      [first.filterMode, first.operation, first.color, first.getBlendValue(), first.getLayer()],
      [0, 0, 0x304050, 0x80, 5],
    );
    assert.deepEqual(
      [
        second.filterMode,
        second.operation,
        second.color,
        second.getBlendValue(),
        second.getLayer(),
      ],
      [0, 0, 0x102030, 0x40, 2],
    );
    const ordered = graph.manager.lists
      .snapshot(false)
      .filter(({object}) => object === first || object === second);
    assert.deepEqual(
      ordered.map(({object}) => object),
      [second, first],
    );
    assert.deepEqual(
      ordered.map(({key}) => key),
      [second.sortKey(), first.sortKey()],
    );
    assert.ok(ordered[0].key < ordered[1].key);

    assert.equal(await invoke(0x90, 0x64, [firstHandle, 1], 0), 0);
    assert.equal(await invoke(0x90, 0x64, [secondHandle, 1], 0), 0);
    assert.deepEqual([first.activation, second.activation], [1, 1]);
    assert.deepEqual([first.inputActive(), second.inputActive()], [1, 1]);
    // Without a selected display context the filters have no drawable extent to damage.
    assert.deepEqual([first.bitmap.stride, second.bitmap.stride], [0, 0]);
    assert.deepEqual(graph.damage.snapshot(), []);
    assert.equal(graph.damage.fullRedraw, 0);
    assert.equal(child.state.stackIndex, 0);

    assert.equal(await invoke(0x90, 0x61, [secondHandle], 0), 0);
    assert.equal(await invoke(0x90, 0x61, [firstHandle], 0), 0);
    assert.equal(graph.manager.find('filter', firstHandle), null);
    assert.equal(graph.manager.find('filter', secondHandle), null);
    assert.equal(graph.manager.categoryCount(1), 0);
    assert.equal(
      graph.manager.lists
        .snapshot(false)
        .filter(({object}) => object === first || object === second).length,
      0,
    );
    assert.deepEqual(graph.damage.snapshot(), []);
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});
