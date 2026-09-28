import test from 'node:test';
import assert from 'node:assert/strict';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';
import {BrowserWindowCoordinatesHost} from '../dist/platform/browser-window-coordinates.js';
import {hostPointer} from '../dist/engines/buriko/bp/memory.js';
// VM banks share one arena buffer; always build views with their byteOffset/byteLength.
const bankView = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

test('mounted graph keeps child screen positions and dragging consistent through host scaling and teardown', async () => {
  const mapping = {originX: -50, originY: -100, nativePixelsPerCssX: 2, nativePixelsPerCssY: 2},
    containingBlock = {
      offsetWidth: 800,
      offsetHeight: 600,
      clientLeft: 0,
      clientTop: 0,
      getBoundingClientRect: () => ({left: 25, top: 50, right: 425, bottom: 350}),
      children: [],
      style: {},
      append(child) {
        this.children.push(child);
        child.parent = this;
      },
    },
    coordinates = new BrowserWindowCoordinatesHost(containingBlock, () => mapping);
  const fixture = await createMountedVmFixture({
    boot: false,
    childWindowCoordinates: coordinates,
    childWindowParent: containingBlock,
  });
  const {graph, memory, encode} = fixture;
  const liveTargets = () =>
    Array.from({length: 32}, (_, index) => index + 1).filter((id) => graph.messages.hasTarget(id));
  try {
    assert.equal(graph.children.parent, containingBlock);
    assert.notEqual(graph.children.parent, graph.host.parent);
    assert.equal(graph.children.messages, graph.messages);
    assert.equal(graph.children.surfaces, graph.surfaces);
    assert.equal(graph.children.coordinates, coordinates);
    assert.deepEqual(liveTargets(), []);
    const output = hostPointer(memory.globalMemory, 0x100);
    assert.equal(graph.children.create(output, hostPointer(encode('Child')), 10, 20, 32, 32, 0), 0);
    const handle = bankView(memory.globalMemory).getUint32(0x100, true);
    assert.equal(handle, 0xf8000000);
    const panel = graph.children.parent.children.find((item) => item.tagName === 'SECTION');
    assert.ok(panel);
    assert.equal(panel.parent, graph.children.parent);
    assert.equal(panel.hidden, true);
    assert.equal(panel.children[0].children[0].textContent, 'Child');
    assert.deepEqual([panel.style.left, panel.style.top], ['10px', '20px']);
    mapping.originX = 50;
    mapping.originY = 100;
    coordinates.refresh();
    assert.deepEqual([panel.style.left, panel.style.top], ['-90px', '-180px']);
    assert.equal(graph.children.getPosition(output, handle), 1);
    assert.deepEqual(
      [
        bankView(memory.globalMemory).getInt32(0x100, true),
        bankView(memory.globalMemory).getInt32(0x104, true),
      ],
      [10, 20],
    );
    graph.children.setPosition(handle, 110, 220);
    const heading = panel.children[0];
    heading.setPointerCapture = () => {};
    heading.hasPointerCapture = () => false;
    heading.listeners.get('pointerdown')({
      pointerId: 1,
      clientX: 30,
      clientY: 60,
      preventDefault() {},
    });
    heading.listeners.get('pointermove')({pointerId: 1, clientX: 40, clientY: 80});
    heading.listeners.get('pointerup')({pointerId: 1});
    assert.deepEqual([panel.style.left, panel.style.top], ['30px', '60px']);
    graph.children.getPosition(output, handle);
    assert.deepEqual(
      [
        bankView(memory.globalMemory).getInt32(0x100, true),
        bankView(memory.globalMemory).getInt32(0x104, true),
      ],
      [130, 260],
    );
    const targets = liveTargets();
    assert.equal(targets.length, 1);
    const target = targets[0];
    assert.equal(graph.messages.hasTarget(target), true);
    await fixture.close();
    assert.equal(panel.parent, null);
    assert.equal(graph.children.parent.children.includes(panel), false);
    assert.equal(graph.messages.hasTarget(target), false);
    assert.throws(() => coordinates.readPosition(panel), /no registered screen position/);
    graph.children.dispose();
    assert.equal(graph.messages.hasTarget(target), false);
  } finally {
    await fixture.close();
  }
});
