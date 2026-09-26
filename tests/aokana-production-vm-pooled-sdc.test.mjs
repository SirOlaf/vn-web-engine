import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted VM decodes a fixed SDC stream into its logged pooled allocation', async () => {
  const fixture = await createMountedVmFixture();
  const {data, graph, memory, child, definitions, fragments, invoke} = fixture;
  const originalInstructionStart = child.state.instructionStart;
  try {
    assert.equal(data.memory, memory);
    assert.equal(graph.resource.errors.files.text, graph.text);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => primary === 0x80 && [0x20, 0x21, 0xc1].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0x20, 0x21, 0xc1],
    );
    assert.equal(fragments.nativeDefinitions().length, definitions.length);
    const encoded = new Uint8Array(41);
    const header = new DataView(encoded.buffer);
    encoded.set(new TextEncoder().encode('SDC FORMAT 1.00\0'));
    header.setUint32(20, 9, true);
    header.setUint32(24, 40, true);
    header.setUint16(28, 1063, true);
    header.setUint16(30, 203, true);
    encoded.set([1, 155, 196, 222, 66, 128, 205, 75, 15], 32);
    memory.globalMemory.fill(0xa5, 0x1f0, 0x240);
    memory.globalMemory.set(encoded, 0x200);
    const module = child.state.modules[0];
    assert.ok(module);
    child.state.instructionStart = module.base + 2;
    data.allocations.enabled = 1;

    assert.equal(await invoke(0x80, 0x20, [64], 0), 1);
    const address = pop32(child.state);
    assert.equal(child.state.stackIndex, 0);
    const destination = memory.pointer(child.state, address, 64);
    destination.bytes.fill(0x7b, destination.offset, destination.offset + 64);
    assert.equal(data.allocations.records.length, 1);
    assert.equal(data.allocations.records[0].address, address);
    assert.match(
      new TextDecoder().decode(data.allocations.records[0].text),
      /Size \[ 64 \].*Program \[ ipl\._bp \].*IP \[ \$00000002 \]/,
    );

    assert.equal(await invoke(0x80, 0xc1, [address, 0x200], 0), 1);
    assert.equal(pop32(child.state), 40);
    assert.equal(child.state.stackIndex, 0);
    assert.deepEqual(
      destination.bytes.subarray(destination.offset, destination.offset + 40),
      new TextEncoder().encode('AB'.repeat(20)),
    );
    assert.deepEqual(
      destination.bytes.subarray(destination.offset + 40, destination.offset + 64),
      new Uint8Array(24).fill(0x7b),
    );
    assert.deepEqual(memory.globalMemory.subarray(0x200, 0x200 + encoded.length), encoded);
    assert.equal(memory.globalMemory[0x1ff], 0xa5);
    assert.equal(memory.globalMemory[0x200 + encoded.length], 0xa5);

    assert.equal(await invoke(0x80, 0x21, [address], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(data.allocations.records.length, 0);
  } finally {
    child.state.instructionStart = originalInstructionStart;
    data.allocations.enabled = 0;
    await fixture.close();
  }
});
