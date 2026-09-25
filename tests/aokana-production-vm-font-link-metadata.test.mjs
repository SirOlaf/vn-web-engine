import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted font-name callbacks feed the shared registered link font', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, definitions, invoke} = fixture;
  const call = async (primary, secondary, args) => {
    assert.equal(await invoke(primary, secondary, args, 0), 1);
    const result = pop32(child.state);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    return result;
  };
  try {
    assert.equal(graph.windowState.textLayout.surfaces, graph.surfaces);
    assert.equal(graph.windowState.textLayout.text, graph.text);
    assert.equal(graph.surfaces.fonts, graph.fonts);
    assert.equal(graph.fonts.text, graph.text);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) =>
            (primary === 0xb0 && [0xc0, 0xc1, 0xc2, 0xc6].includes(secondary)) ||
            (primary === 0x91 && [0x99, 0x9b].includes(secondary)) ||
            (primary === 0x92 && [0x94, 0x95, 0x99, 0x9b, 0x9d, 0x9e, 0x9f].includes(secondary)),
        )
        .map(({primary, secondary}) => [primary, secondary]),
      [
        [0xb0, 0xc0],
        [0xb0, 0xc1],
        [0x92, 0x9d],
      ],
    );

    memory.globalMemory.set(new TextEncoder().encode('Shared\0'), 0x100);
    memory.globalMemory.set(new TextEncoder().encode('Alternate\0'), 0x140);
    assert.equal(await call(0xb0, 0xc0, [0x100]), 0);
    assert.equal(await call(0xb0, 0xc1, [0x140, 2]), 1);
    assert.equal(await call(0xb0, 0xc1, [0x100, 1]), 0);
    assert.equal(graph.fonts.registeredNames.length, 2);
    assert.deepEqual([...graph.fonts.name(1)], [...new TextEncoder().encode('Alternate')]);
    assert.equal(await graph.fonts.charset(new TextEncoder().encode('Alternate')), 134);
    assert.equal(await graph.fonts.charset(new TextEncoder().encode('Shared')), 0);

    assert.equal(await call(0x92, 0x9d, [1, 12, 100, 1, 1]), 0);
    const expected = new Uint8Array(120);
    expected.set(new TextEncoder().encode('Alternate\0'));
    const fields = new DataView(expected.buffer);
    fields.setInt32(96, 12, true);
    fields.setInt32(100, 100, true);
    fields.setInt32(104, 1, true);
    fields.setInt32(108, 1, true);
    assert.deepEqual([...graph.windowState.textLayout.alternateFontName], [...expected]);
    assert.deepEqual(
      [...memory.globalMemory.subarray(0x100, 0x107)],
      [...new TextEncoder().encode('Shared\0')],
    );
    assert.deepEqual(
      [...memory.globalMemory.subarray(0x140, 0x14a)],
      [...new TextEncoder().encode('Alternate\0')],
    );
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});
