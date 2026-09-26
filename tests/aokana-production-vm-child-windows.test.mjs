import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted B0 child state callbacks share DOM, scroll, clipboard, and close owners', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, definitions, invoke, encode} = fixture;
  const call = async (secondary, args, pushed = 0) => {
    assert.equal(await invoke(0xb0, secondary, args, 0), pushed);
    assert.equal(child.process, null);
  };
  const liveTargets = () =>
    Array.from({length: 32}, (_, index) => index + 1).filter((id) => graph.messages.hasTarget(id));
  const all = (element) => element.children.flatMap((entry) => [entry, ...all(entry)]);
  try {
    assert.equal(graph.children.document, graph.host.document);
    assert.equal(graph.children.parent, graph.host.parent);
    assert.equal(graph.children.messages, graph.messages);
    assert.equal(graph.children.surfaces, graph.surfaces);
    assert.deepEqual(
      definitions.filter(({primary}) => primary === 0xb0).map(({secondary}) => secondary),
      [
        0x60, 0x61, 0x62, 0x63, 0x66, 0x67, 0x68, 0x6a, 0x6c, 0x6d, 0x6f, 0x80, 0x81, 0x82, 0x83,
        0x8c, 0x84, 0x85, 0x86, 0x87, 0x8f, 0xa0, 0xa1, 0xa2, 0xa3, 0x10, 0x11, 0x12, 0x14, 0x15,
        0x16, 0x17, 0x1c, 0x1e, 0x1f, 0x04, 0x05, 0x06, 0xc0, 0xc1,
      ],
    );
    assert.equal(
      definitions.some(
        ({primary, secondary}) => primary === 0xb0 && [0x18, 0x19, 0x1a, 0x1b].includes(secondary),
      ),
      false,
    );
    memory.globalMemory.set(encode('First child'), 0x100);
    memory.globalMemory.set(encode('Scrolled child'), 0x120);
    memory.globalMemory.set(encode('Changed title'), 0x150);
    memory.globalMemory.set(encode('Copied'), 0x180);
    await call(0x10, [0x100, -7, 9, 32, 32], 1);
    const first = pop32(child.state);
    assert.equal(first, 0xf8000000);
    const firstPanel = graph.children.parent.children.find((item) => item.tagName === 'SECTION');
    assert.ok(firstPanel);
    assert.equal(firstPanel.children[0].children[0].textContent, 'First child');
    assert.equal(liveTargets().length, 1);
    const firstTarget = liveTargets()[0];
    await call(0x17, [first], 2);
    assert.equal(pop32(child.state), 9);
    assert.equal(pop32(child.state), 0xfffffff9);
    await call(0x12, [0x120, 10, 20, 32, 32, 3], 1);
    const second = pop32(child.state);
    assert.equal(second, 0xf8000001);
    const secondPanel = graph.children.parent.children.filter(
      (item) => item.tagName === 'SECTION',
    )[1];
    assert.ok(secondPanel);
    assert.equal(secondPanel.children[0].children[0].textContent, 'Scrolled child');
    const secondTarget = liveTargets().find((target) => target !== firstTarget);
    assert.ok(secondTarget);
    await call(0x11, [first]);
    assert.equal(firstPanel.parent, null);
    assert.equal(graph.messages.hasTarget(firstTarget), false);
    assert.equal(graph.messages.hasTarget(secondTarget), true);

    await call(0x17, [second], 2);
    assert.equal(pop32(child.state), 20);
    assert.equal(pop32(child.state), 10);
    await call(0x16, [second, 30, 40]);
    await call(0x17, [second], 2);
    assert.equal(pop32(child.state), 40);
    assert.equal(pop32(child.state), 30);
    assert.deepEqual([secondPanel.style.left, secondPanel.style.top], ['30px', '40px']);
    await call(0x14, [second, 1]);
    assert.equal(secondPanel.hidden, false);
    await call(0x14, [second, 0]);
    assert.equal(secondPanel.hidden, true);
    await call(0x15, [second, 0x150]);
    assert.equal(secondPanel.children[0].children[0].textContent, 'Changed title');
    await call(0x1c, [second, 0x180]);
    // The clipboard field is retained by this owner; no host clipboard write is requested.
    assert.deepEqual([...graph.children.records[1].clipboard], [...encode('Copied')]);
    memory.globalMemory[0x180] = 0x58;
    assert.deepEqual([...graph.children.records[1].clipboard], [...encode('Copied')]);

    await call(0x1e, [second, 0, (2 << 16) | 20], 1);
    assert.equal(pop32(child.state), 0);
    await call(0x1e, [second, 1, (3 << 16) | 10], 1);
    assert.equal(pop32(child.state), 0);
    await call(0x1e, [second, 2, 5], 1);
    assert.equal(pop32(child.state), 0);
    const scrollbars = all(secondPanel).filter((item) => item.role === 'scrollbar');
    assert.equal(scrollbars.length, 2);
    assert.ok(scrollbars.every((bar) => bar.disabled === false));
    const output = new DataView(memory.globalMemory.buffer);
    for (const [selector, expected] of [
      [0, 20],
      [1, 10],
      [2, 0],
    ]) {
      memory.globalMemory.fill(0xa5, 0x200, 0x208);
      await call(0x1f, [0x200, second, selector], 1);
      assert.equal(pop32(child.state), 0);
      assert.equal(output.getInt32(0x200, true), expected);
      assert.deepEqual([...memory.globalMemory.subarray(0x204, 0x208)], [0xa5, 0xa5, 0xa5, 0xa5]);
    }
    assert.equal(child.state.stackIndex, 0);
    await fixture.close();
    assert.equal(secondPanel.parent, null);
    assert.equal(graph.messages.hasTarget(secondTarget), false);
  } finally {
    await fixture.close();
  }
});
