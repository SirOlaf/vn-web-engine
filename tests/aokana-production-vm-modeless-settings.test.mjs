import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

function descendants(element, tagName, type) {
  return element.children.flatMap((child) => [
    ...(child.tagName === tagName && (type === undefined || child.type === type) ? [child] : []),
    ...descendants(child, tagName, type),
  ]);
}

test('mounted B0 settings windows share dialog transitions, BP events, and graph teardown', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, memory, definitions, invoke} = fixture;
  const transitions = [];
  const originalTransition = graph.dialogs.transition.bind(graph.dialogs);
  graph.dialogs.transition = (enter) => {
    transitions.push(enter);
    originalTransition(enter);
  };
  const view = new DataView(memory.globalMemory.buffer);
  const call = async (secondary, args, expected) => {
    assert.equal(await invoke(0xb0, secondary, args, 0), 1);
    assert.equal(pop32(child.state), expected);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  };
  const panel = () =>
    graph.host.parent.children.find(
      (child) => child.tagName === 'SECTION' && child['aria-label'] === '環境設定',
    );
  try {
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) =>
            primary === 0xb0 && [0xa0, 0xa1, 0xa2, 0xa3].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0xa0, 0xa1, 0xa2, 0xa3],
    );
    assert.equal(graph.modelessSettings.document, graph.host.document);
    assert.equal(graph.modelessSettings.parent, graph.host.parent);
    assert.equal(graph.modelessSettings.dialogs, graph.dialogs);

    [5, 6, 70, 80, 90, 0, 1, 1, 0].forEach((value, index) =>
      view.setInt32(0x100 + index * 4, value, true),
    );
    memory.globalMemory.fill(0xa5, 0x200, 0x210);
    await call(0xa0, [0x200, 0, 0x100], 1);
    const firstId = view.getInt32(0x200, true);
    assert.equal(firstId, 1);
    assert.deepEqual([...memory.globalMemory.subarray(0x204, 0x210)], Array(12).fill(0xa5));
    const first = panel();
    assert.ok(first);
    assert.equal(first.hidden, true);
    assert.deepEqual(
      descendants(first, 'INPUT', 'range').map(({value}) => value),
      ['5', '6', '70', '80', '90'],
    );
    await call(0xa2, [firstId, 1], 1);
    assert.equal(first.hidden, false);
    const slider = descendants(first, 'INPUT', 'range')[0];
    slider.value = '37';
    slider.listeners.get('input')();
    memory.globalMemory.fill(0xa5, 0x300, 0x310);
    await call(0xa3, [0x300, firstId], 0);
    assert.deepEqual([view.getInt32(0x300, true), view.getInt32(0x304, true)], [0, 37]);
    assert.deepEqual([...memory.globalMemory.subarray(0x308, 0x310)], Array(8).fill(0xa5));
    await call(0xa3, [0x300, firstId], 1);
    assert.deepEqual([view.getInt32(0x300, true), view.getInt32(0x304, true)], [0, 37]);
    await call(0xa1, [firstId], 1);
    assert.equal(first.parent, null);
    assert.deepEqual(transitions, [true, false]);

    memory.globalMemory.fill(0xa5, 0x220, 0x224);
    await call(0xa0, [0x220, 0, 0x100], 1);
    const secondId = view.getInt32(0x220, true);
    assert.equal(secondId, 2);
    const second = panel();
    assert.ok(second);
    await call(0xa2, [secondId, 1], 1);
    const secondSlider = descendants(second, 'INPUT', 'range')[0];
    secondSlider.value = '44';
    secondSlider.listeners.get('input')();
    assert.equal(second.hidden, false);
    assert.equal(child.state.stackIndex, 0);
    await fixture.close();
    assert.equal(second.parent, null);
    assert.deepEqual(transitions, [true, false, true, false]);
  } finally {
    await fixture.close();
  }
});
