import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted display-service state callbacks share the existing preset and device owners', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, child, definitions, invoke} = fixture;
  const read = async (primary, secondary) => {
    assert.equal(await invoke(primary, secondary, [], 0), 1);
    const value = pop32(child.state);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    return value;
  };
  const write = async (primary, secondary, args, pushed = 0) => {
    assert.equal(await invoke(primary, secondary, args, 0), pushed);
    assert.equal(child.process, null);
  };
  try {
    assert.equal(graph.controller.manager, graph.manager);
    assert.equal(graph.controller.device, graph.device);
    assert.equal(graph.manager.displayState, graph.display);
    assert.equal(graph.device.canvas, graph.host.surface);
    assert.equal(graph.resource.errors.files, graph.resource.files);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) =>
            primary === 0x80 && [0x60, 0x61, 0x63, 0x6e, 0x6f].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0x61, 0x63, 0x6f],
    );
    assert.equal(graph.device.isPresent(), false);
    assert.deepEqual([graph.display.desktopWidth, graph.display.desktopHeight], [800, 600]);
    assert.deepEqual([graph.display.logicalWidth, graph.display.logicalHeight], [800, 600]);
    assert.equal(await read(0x80, 0x61), 0);
    assert.equal(await read(0x80, 0x6f), 0);

    await write(0x81, 0x63, [2], 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(await read(0x81, 0x61), 2);
    await write(0x80, 0x63, [0]);
    assert.equal(graph.display.displayMode, 1);
    assert.equal(await read(0x81, 0x61), 1);
    await write(0x80, 0x63, [7]);
    assert.equal(graph.display.displayMode, 0);
    assert.equal(await read(0x81, 0x61), 0);

    await write(0x81, 0x60, [2, 960, 540], 1);
    assert.equal(pop32(child.state), 0);
    assert.deepEqual([graph.display.logicalWidth, graph.display.logicalHeight], [960, 540]);
    assert.equal(await read(0x80, 0x6f), 1);
    assert.equal(graph.device.isPresent(), false);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});
