import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted text callbacks share persistent annotations and parse raw tags', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, definitions, invoke} = fixture;
  const layout = graph.windowState.textLayout;
  const call = async (secondary, args, pushed = 0) => {
    assert.equal(await invoke(0x91, secondary, args, 0), pushed);
    assert.equal(child.process, null);
  };
  const pop = () => {
    const value = pop32(child.state);
    assert.equal(child.state.stackIndex, 0);
    return value;
  };
  try {
    assert.equal(layout.surfaces, graph.surfaces);
    assert.equal(layout.text, graph.text);
    assert.equal(layout.annotations.text, graph.text);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) =>
            primary === 0x91 &&
            [0x94, 0x95, 0x96, 0x98, 0x99, 0x9b, 0x9e, 0x9f].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0x94, 0x96, 0x95, 0x9e, 0x9f],
    );
    memory.globalMemory.set(new TextEncoder().encode('AB\0'), 0x100);
    memory.globalMemory.set(new TextEncoder().encode('reading\0'), 0x120);
    memory.globalMemory.set(new TextEncoder().encode('AB AB\0'), 0x140);
    const expected = new TextEncoder().encode('AB\\reading\nAB\\reading\n\0');
    await call(0x94, [0x100, 0x120]);
    memory.globalMemory.fill(0xa5, 0x200, 0x240);
    await call(0x95, [0x200, 0x140], 1);
    assert.equal(pop(), 2);
    assert.deepEqual(
      [...memory.globalMemory.subarray(0x200, 0x200 + expected.length)],
      [...expected],
    );
    assert.equal(memory.globalMemory[0x200 + expected.length], 0xa5);

    await call(0x94, [0, 0]);
    assert.equal(layout.annotations.first, null);
    await call(0x96, [0x200], 1);
    assert.equal(pop(), 1);
    memory.globalMemory.fill(0xa5, 0x280, 0x2c0);
    await call(0x95, [0x280, 0x140], 1);
    assert.equal(pop(), 2);
    assert.deepEqual(
      [...memory.globalMemory.subarray(0x280, 0x280 + expected.length)],
      [...expected],
    );

    memory.globalMemory.set(graph.text.encodeWide('<l>海</l>と<L>空</L>', 1), 0x400);
    memory.globalMemory.fill(0xa5, 0x600, 0x700);
    await call(0x9e, [0x600, 0x400], 1);
    assert.equal(pop(), 2);
    for (const [index, bytes] of [
      [0xe6, 0xb5, 0xb7, 0],
      [0xe7, 0xa9, 0xba, 0],
    ].entries()) {
      const offset = 0x600 + index * 128;
      assert.deepEqual([...memory.globalMemory.subarray(offset, offset + 4)], bytes);
      assert.ok(memory.globalMemory.subarray(offset + 4, offset + 128).every((byte) => byte === 0));
    }
    memory.globalMemory.set(new TextEncoder().encode('pre<l>sea</l><b>sky</b>end\0'), 0x800);
    memory.globalMemory.fill(0xa5, 0x900, 0x940);
    await call(0x9f, [0x900, 0x800]);
    assert.deepEqual(
      [...memory.globalMemory.subarray(0x900, 0x90d)],
      [...new TextEncoder().encode('preseaskyend\0')],
    );
    assert.equal(memory.globalMemory[0x90d], 0xa5);
    await call(0x94, [0, 0]);
    assert.equal(layout.annotations.first, null);
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});
