import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted 7F callbacks share BP indirect memory and sort complete records', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, data, memory, child, definitions, invoke} = fixture;
  const bp = new DataView(memory.globalMemory.buffer);
  const call = async (secondary, args) => {
    assert.equal(await invoke(0x7f, secondary, args, 0), 1);
    assert.equal(child.process, null);
    const result = pop32(child.state);
    assert.equal(child.state.stackIndex, 0);
    return result;
  };
  try {
    assert.equal(data.graph, graph);
    assert.equal(data.memory, memory);
    assert.equal(graph.resource.files.text, graph.text);
    assert.deepEqual(
      definitions.filter(({primary}) => primary === 0x7f).map(({secondary}) => secondary),
      [0x00, 0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x88, 0x89, 0x8a, 0x8b],
    );

    assert.equal(await call(0x80, [0x100, 4]), 0);
    const buffer = bp.getUint32(0x100, true);
    assert.ok(buffer >= 0x0fff0000 && buffer < 0x0fff1000);
    assert.equal(await call(0x83, [buffer]), 4);
    memory.globalMemory.set([1, 2, 3, 4, 9, 8], 0x300);
    assert.equal(await call(0x84, [buffer, 0, 0x300, 4]), 0);
    assert.equal(await call(0x86, [buffer, 2, 0x304, 2]), 0);
    assert.equal(await call(0x83, [buffer]), 6);
    memory.globalMemory.fill(0xa5, 0x400, 0x408);
    assert.equal(await call(0x85, [0x400, buffer, 0, 6]), 0);
    assert.deepEqual(
      [...memory.globalMemory.subarray(0x400, 0x408)],
      [1, 2, 9, 8, 3, 4, 0xa5, 0xa5],
    );
    assert.equal(await call(0x82, [buffer, 3]), 0);
    assert.equal(await call(0x83, [buffer]), 3);
    memory.globalMemory.fill(0xa5, 0x400, 0x408);
    assert.equal(await call(0x85, [0x400, buffer, 0, 3]), 0);
    assert.deepEqual(
      [...memory.globalMemory.subarray(0x400, 0x408)],
      [1, 2, 9, 0xa5, 0xa5, 0xa5, 0xa5, 0xa5],
    );
    assert.equal(await call(0x81, [buffer]), 0);

    memory.globalMemory.set(new TextEncoder().encode('hi\0'), 0x600);
    memory.globalMemory.set(new TextEncoder().encode('A%d:%sZ\0'), 0x640);
    assert.equal(await call(0x88, [0x120, 0x600]), 0);
    const string = bp.getUint32(0x120, true);
    assert.ok(string >= 0x0fff1000 && string < 0x0fff2000);
    const value = () => new TextDecoder().decode(memory.readCString(child.state, string));
    assert.equal(value(), 'hi');
    assert.equal(await call(0x8a, [0x600, 12, string, 1, 0x640]), 0);
    assert.equal(value(), 'hA12:hiZi');
    assert.equal(await call(0x8b, [0x600, 34, string, 0x640]), 0);
    assert.equal(value(), 'A34:hiZ');
    assert.equal(await call(0x89, [string]), 0);

    for (const [index, key] of [3, -4, 2, -1].entries()) {
      bp.setInt32(0x700 + index * 8, key, true);
      bp.setUint32(0x704 + index * 8, index, true);
    }
    assert.equal(await call(0x00, [0x700, 4, 8, 0, 4]), 0);
    assert.deepEqual(
      Array.from({length: 4}, (_, index) => [
        bp.getInt32(0x700 + index * 8, true),
        bp.getUint32(0x704 + index * 8, true),
      ]),
      [
        [-4, 1],
        [-1, 3],
        [2, 2],
        [3, 0],
      ],
    );
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});
