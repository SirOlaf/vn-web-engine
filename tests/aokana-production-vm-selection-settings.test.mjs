import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaWindowDisplayObject} from '../dist/engines/buriko/games/aokana/native/display-window.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted selection settings share the policy owner and copy Window item colors', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, data, child, definitions, memory, invoke} = fixture;
  const view = new DataView(memory.globalMemory.buffer);
  const call = async (secondary, args) => {
    assert.equal(await invoke(0x90, secondary, args, 0), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  };
  try {
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => primary === 0x90 && secondary >= 0xa0 && secondary <= 0xa7,
        )
        .map(({secondary}) => secondary),
      [0xa4, 0xa5, 0xa6, 0xa7],
    );
    assert.equal(data.graph, graph);
    assert.equal(data.memory, memory);
    assert.equal(graph.windowState.manager, graph.manager);
    assert.equal(graph.cursorMotion.input, graph.input);
    assert.equal(graph.cursorMotion.clock, graph.clock);
    assert.equal(graph.resource.errors.files.text, graph.text);
    assert.equal(graph.device.isPresent(), false);

    await call(0xa4, [0x112233, 0x445566]);
    assert.deepEqual(data.textSelection.colors, [0x112233, 0x445566]);
    await call(0xa5, [42]);
    assert.equal(data.textSelection.interval, 42);
    await call(0xa6, [3, 4, 5, 6]);
    assert.deepEqual(
      [
        data.textSelection.wheelMotion,
        data.textSelection.cursorEasing,
        data.textSelection.cursorDuration,
        data.textSelection.cursorRate,
      ],
      [3, 4, 5, 6],
    );

    assert.equal(graph.manager.configureDescriptor(64, 32, 1, 64 * 32), 1);
    assert.equal(await invoke(0x90, 0x80, [32, 24], 0), 1);
    const handle = pop32(child.state);
    assert.equal(child.state.stackIndex, 0);
    const window = graph.manager.find('window', handle);
    assert.ok(window instanceof AokanaWindowDisplayObject);

    const colors = Array.from({length: 16}, (_, index) => 0x01020300 + index);
    for (let index = 0; index < colors.length; index++) {
      view.setUint32(0x200 + index * 4, colors[index], true);
    }
    await call(0xa7, [handle, 0x200]);
    const retained = new Uint32Array(16);
    assert.equal(window.getTextParameters(retained), 1);
    assert.deepEqual([...retained], colors);
    view.setUint32(0x200, 0xdeadbeef, true);
    const copied = new Uint32Array(16);
    assert.equal(window.getTextParameters(copied), 1);
    assert.deepEqual([...copied], colors);
    await call(0xa7, [handle, 0]);
    assert.equal(window.getTextParameters(new Uint32Array(16)), 0);
    await call(0x81, [handle]);
    assert.equal(graph.manager.find('window', handle), null);
    assert.equal(graph.device.isPresent(), false);
  } finally {
    await fixture.close();
  }
});
