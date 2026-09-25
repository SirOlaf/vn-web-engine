import test from 'node:test';
import assert from 'node:assert/strict';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted graph initializes child windows and closes their DOM and numeric target', async () => {
  const fixture = await createMountedVmFixture({boot: false});
  const {graph, memory, encode} = fixture;
  const liveTargets = () =>
    Array.from({length: 32}, (_, index) => index + 1).filter((id) => graph.messages.hasTarget(id));
  try {
    assert.equal(graph.children.parent, graph.host.parent);
    assert.equal(graph.children.messages, graph.messages);
    assert.equal(graph.children.surfaces, graph.surfaces);
    assert.deepEqual(liveTargets(), []);
    const output = {bytes: memory.globalMemory, offset: 0x100};
    assert.equal(
      graph.children.create(output, {bytes: encode('Child'), offset: 0}, 10, 20, 32, 32, 0),
      0,
    );
    const handle = new DataView(memory.globalMemory.buffer).getUint32(0x100, true);
    assert.equal(handle, 0xf8000000);
    const panel = graph.children.parent.children.find((item) => item.tagName === 'SECTION');
    assert.ok(panel);
    assert.equal(panel.parent, graph.children.parent);
    assert.equal(panel.hidden, true);
    assert.equal(panel.children[0].children[0].textContent, 'Child');
    assert.equal(graph.children.getPosition(output, handle), 1);
    assert.deepEqual(
      [
        new DataView(memory.globalMemory.buffer).getInt32(0x100, true),
        new DataView(memory.globalMemory.buffer).getInt32(0x104, true),
      ],
      [10, 20],
    );
    const targets = liveTargets();
    assert.equal(targets.length, 1);
    const target = targets[0];
    assert.equal(graph.messages.hasTarget(target), true);
    await fixture.close();
    assert.equal(panel.parent, null);
    assert.equal(graph.children.parent.children.includes(panel), false);
    assert.equal(graph.messages.hasTarget(target), false);
    graph.children.dispose();
    assert.equal(graph.messages.hasTarget(target), false);
  } finally {
    await fixture.close();
  }
});
