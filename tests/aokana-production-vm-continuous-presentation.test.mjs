import assert from 'node:assert/strict';
import test from 'node:test';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted continuous-presentation callback updates the frame policy display owner', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, invoke} = fixture;
  try {
    assert.equal(graph.manager.displayState, graph.display);
    assert.equal(graph.frames.manager, graph.manager);
    assert.equal(graph.frames.display, graph.display);
    assert.equal(graph.device.isPresent(), false);
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x91 && [0x00, 0x09].includes(secondary))
        .map(({secondary}) => secondary),
      [0x00],
    );
    assert.equal(graph.display.continuousPresentation, 0);

    for (const value of [1, 0]) {
      assert.equal(await invoke(0x91, 0x00, [value], 0), 0);
      assert.equal(graph.display.continuousPresentation, value);
      assert.equal(graph.frames.display.continuousPresentation, value);
      assert.equal(child.state.stackIndex, 0);
      assert.equal(child.process, null);
    }
    assert.equal(graph.device.isPresent(), false);
  } finally {
    await fixture.close();
  }
});
