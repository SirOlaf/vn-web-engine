import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted E0:3F formats a BP bitmap description with the shared graph text owner', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, definitions, invoke} = fixture;
  const view = new DataView(memory.globalMemory.buffer);
  try {
    assert.ok(definitions.some(({primary, secondary}) => primary === 0xe0 && secondary === 0x3f));
    assert.equal(graph.resource.files.text, graph.text);
    memory.globalMemory.fill(0xa5, 0x100, 0x100 + 40);
    memory.globalMemory.fill(0xb6, 0x200, 0x200 + 0x40);
    memory.globalMemory.fill(0xc7, 0x300, 0x300 + 0xc4);
    view.setUint32(0x100, 1, true);
    view.setUint32(0x104, 0x200, true);
    view.setUint32(0x200, 1, true);
    view.setUint32(0x208, 0x300, true);
    [1, 0, -2, 3, -4, 5, 6, -7, 8, 9, 10, 11, -1].forEach((value, index) =>
      view.setInt32(0x300 + index * 4, value, true),
    );
    const sources = [
      memory.globalMemory.slice(0x100, 0x128),
      memory.globalMemory.slice(0x200, 0x240),
      memory.globalMemory.slice(0x300, 0x300 + 0xc4),
    ];
    memory.globalMemory.fill(0xcc, 0x500, 0x700);

    assert.equal(await invoke(0xe0, 0x3f, [0x500, 0x100], 0), 1);
    const length = pop32(child.state);
    const expected =
      '- Group [ 0 ] -\n\n\tUnit [   0 ] / Validity : TRUE  / Visibility : FALSE / Position(   -2,    3 ) / Origin(   -4,    5 ) / Bitmaps : 6 / ChangeInterval : -7 / BaseBitmaps( 8, 9, 10, 11 ) / BitmapForVPD : -1\n\n';
    const encoded = new TextEncoder().encode(`${expected}\0`);
    assert.equal(length, encoded.length - 1);
    assert.deepEqual(memory.globalMemory.subarray(0x500, 0x500 + length + 1), encoded);
    assert.equal(memory.globalMemory[0x500 + length], 0);
    assert.equal(memory.globalMemory[0x500 + length + 1], 0xcc);
    assert.deepEqual(memory.globalMemory.subarray(0x100, 0x128), sources[0]);
    assert.deepEqual(memory.globalMemory.subarray(0x200, 0x240), sources[1]);
    assert.deepEqual(memory.globalMemory.subarray(0x300, 0x300 + 0xc4), sources[2]);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});
