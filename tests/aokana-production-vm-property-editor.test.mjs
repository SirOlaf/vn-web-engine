import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted property editor follows a live Sprite and owns its tabs, rows, and events', async () => {
  const fixture = await createMountedVmFixture();
  const {graph, memory, child, definitions, invoke, encode} = fixture;
  const bp = new DataView(memory.globalMemory.buffer);
  const call = async (primary, secondary, args, pushed = 1) => {
    assert.equal(await invoke(primary, secondary, args, 0), pushed);
    assert.equal(child.process, null);
    if (pushed === 0) return undefined;
    const result = pop32(child.state);
    assert.equal(child.state.stackIndex, 0);
    return result;
  };
  const put = (address, value) => memory.globalMemory.set(encode(value), address);
  const all = (element) => element.children.flatMap((child) => [child, ...all(child)]);
  const named = (element, value) => all(element).find((item) => item.textContent === value);
  const read = async (editor, tab, row) => {
    assert.equal(await call(0xb0, 0x6f, [0x400, 0x404, editor, tab, row]), 0);
    return [bp.getUint32(0x400, true), bp.getUint32(0x404, true)];
  };
  try {
    assert.equal(graph.properties.text, graph.text);
    assert.equal(graph.properties.messages, graph.messages);
    assert.equal(graph.properties.document, graph.host.document);
    assert.equal(graph.properties.parent, graph.host.parent);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) =>
            primary === 0xb0 &&
            [0x60, 0x61, 0x62, 0x63, 0x66, 0x67, 0x68, 0x6a, 0x6c, 0x6d, 0x6f].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0x60, 0x61, 0x62, 0x63, 0x66, 0x67, 0x68, 0x6a, 0x6c, 0x6d, 0x6f],
    );
    assert.equal(
      definitions.filter(({primary, secondary}) => primary === 0xe0 && secondary === 0x20).length,
      1,
    );
    await call(0x90, 0x11, [0, 3, 3, 2], 0);
    await call(0x90, 0x13, [0, 0xff204060], 0);
    const spriteHandle = await call(0x90, 0x50, []);
    assert.equal(spriteHandle, 0x80000000);
    await call(0x90, 0x56, [spriteHandle, 1, 2, 0, 0x80, 0, 2], 0);
    await call(0x90, 0x54, [spriteHandle, 1], 0);
    put(0x120, 'Properties');
    put(0x160, 'Sprite editor');
    put(0x180, 'Extras');
    put(0x190, 'Action');
    put(0x1a0, 'Sprite properties');
    put(0x1d0, 'Static');
    put(0x1e0, 'Live');
    assert.equal(await call(0xb0, 0x60, [0x100, 0x120, 0x160, 10, 20, 180, 140]), 0);
    const editor = bp.getUint32(0x100, true);
    assert.equal(editor, 0xf8000001);
    const panel = all(graph.properties.parent).find((item) => item.tagName === 'SECTION');
    assert.ok(panel);
    assert.equal(named(panel, 'Properties').tagName, 'H2');
    assert.equal(named(panel, 'Sprite editor').tagName, 'P');
    assert.deepEqual([panel.style.left, panel.style.top], ['10px', '20px']);
    assert.equal(await call(0xb0, 0x62, [editor, 30, 40]), 0);
    assert.equal(await call(0xb0, 0x63, [0x210, editor]), 0);
    assert.deepEqual([bp.getInt32(0x210, true), bp.getInt32(0x214, true)], [30, 40]);
    assert.deepEqual([panel.style.left, panel.style.top], ['30px', '40px']);

    assert.equal(await call(0xe0, 0x20, [0x220, editor, spriteHandle, 0x1a0]), 0);
    assert.equal(bp.getUint32(0x220, true), 0);
    assert.deepEqual(await read(editor, 0, 0), [spriteHandle, 2]);
    assert.deepEqual(await read(editor, 0, 6), [1, 0]);
    assert.deepEqual(await read(editor, 0, 7), [2, 0]);
    assert.equal(named(panel, 'Position X').parent.children[1].textContent, '1');
    await call(0x90, 0x33, [spriteHandle, 5, 6], 0);
    assert.equal(await call(0xb0, 0x66, [editor]), 0);
    assert.deepEqual(await read(editor, 0, 6), [5, 0]);
    assert.deepEqual(await read(editor, 0, 7), [6, 0]);
    assert.equal(named(panel, 'Position X').parent.children[1].textContent, '5');

    assert.equal(await call(0xb0, 0x68, [0x260, editor, 0x180]), 0);
    assert.equal(bp.getUint32(0x260, true), 1);
    assert.equal(await call(0xb0, 0x6a, [0x264, editor, 0x190]), 0);
    assert.equal(bp.getUint32(0x264, true), 0);
    assert.equal(await call(0xb0, 0x6c, [0x268, editor, 1, 0x1d0, 0, 42]), 0);
    assert.equal(bp.getUint32(0x268, true), 0);
    bp.setInt32(0x300, 17, true);
    assert.equal(await call(0xb0, 0x6d, [0x26c, editor, 1, 0x1e0, 0, 0x300, 0]), 0);
    assert.equal(bp.getUint32(0x26c, true), 1);
    assert.deepEqual(await read(editor, 1, 0), [42, 0]);
    assert.deepEqual(await read(editor, 1, 1), [17, 0]);
    bp.setInt32(0x300, 23, true);
    assert.equal(await call(0xb0, 0x66, [editor]), 0);
    assert.deepEqual(await read(editor, 1, 1), [23, 0]);
    memory.globalMemory.fill(0xa5, 0x340, 0x350);
    assert.equal(await call(0xb0, 0x67, [0x340, editor]), 6);
    assert.ok(memory.globalMemory.subarray(0x340, 0x350).every((byte) => byte === 0xa5));
    named(panel, 'Extras').listeners.get('click')();
    assert.equal(await graph.properties.handleMessage(graph.messages.take()), true);
    assert.equal(await call(0xb0, 0x67, [0x340, editor]), 0);
    assert.deepEqual([bp.getInt32(0x340, true), bp.getInt32(0x344, true)], [2, 1]);
    assert.equal(named(panel, 'Live').parent.children[1].textContent, '23');
    named(panel, 'Action').listeners.get('click')();
    assert.equal(await graph.properties.handleMessage(graph.messages.take()), true);
    assert.equal(await call(0xb0, 0x67, [0x340, editor]), 0);
    assert.deepEqual([bp.getInt32(0x340, true), bp.getInt32(0x344, true)], [1, 0]);
    assert.equal(await call(0xb0, 0x61, [editor]), 0);
    assert.equal(all(graph.properties.parent).includes(panel), false);
    await call(0x90, 0x51, [spriteHandle], 0);
    assert.equal(graph.manager.find('sprite', spriteHandle), null);
    assert.equal(await call(0x90, 0x12, [0]), 1);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});
