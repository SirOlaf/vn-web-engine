import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('selected font provider mounts the B0 inline EDIT lifecycle on the graph', async () => {
  const created = [];
  const fontProvider = {
    async queryPitch() {
      return null;
    },
    async queryCharset() {
      return 1;
    },
    async enumerate() {
      return [];
    },
    async loadResource() {
      return null;
    },
    unloadResource() {
      return false;
    },
    async create(parameters) {
      created.push(parameters);
      return {
        faceName: parameters.face,
        familyName: parameters.face,
        cssFamily: parameters.face,
        averageWidth: 8,
        ascent: 16,
        emSize: 16,
        horizontalScale: 1,
        abc() {
          return [0, 8, 0];
        },
        extent() {
          return 8;
        },
        rasterText() {
          assert.fail('inline EDIT uses a DOM control');
        },
        rasterMonochrome() {
          assert.fail('inline EDIT uses a DOM control');
        },
        outline() {
          assert.fail('inline EDIT uses a DOM control');
        },
      };
    },
    dispose() {},
  };
  const fixture = await createMountedVmFixture({fontProvider});
  const {graph, memory, child, definitions, invoke} = fixture;
  const call = async (secondary, args, pushes = 0) => {
    assert.equal(await invoke(0xb0, secondary, args, 0), pushes);
    assert.equal(child.process, null);
  };
  const popResult = () => {
    const result = pop32(child.state);
    assert.equal(child.state.stackIndex, 0);
    return result;
  };
  try {
    assert.equal(graph.fontProvider, fontProvider);
    assert.equal(graph.fonts.browser, fontProvider);
    assert.equal(graph.inline.host, graph.host);
    assert.equal(graph.inline.fonts, graph.fonts);
    assert.equal(graph.inline.dialogs, graph.dialogs);
    assert.equal(graph.inline.messages, graph.messages);
    assert.equal(graph.inline.keyboard, graph.keyboard);
    assert.equal(graph.device.isPresent(), false);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => primary === 0xb0 && secondary >= 0x20 && secondary <= 0x2a,
        )
        .map(({secondary}) => secondary),
      Array.from({length: 11}, (_, index) => 0x20 + index),
    );
    // The graph has display metadata but no selected device or raster.
    graph.display.requestedWidth = 800;
    graph.display.requestedHeight = 600;

    memory.globalMemory.set(graph.text.encodeWide('Synthetic', 1), 0x100);
    memory.globalMemory.set(graph.text.encodeWide('Hello', 1), 0x180);
    await call(0xc1, [0x100, 1], 1);
    const font = popResult();
    assert.equal(font, 0);
    await call(0x22, [150], 1);
    assert.equal(popResult(), 1);
    await call(0x25, [0x123456]);
    await call(0x26, [0x180]);
    await call(0x28, [1]);
    await call(0x29, [0]);
    await call(0x2a, [1], 1);
    assert.equal(popResult(), 1);
    assert.equal(graph.inline.state.widthPercent, 150);
    assert.equal(graph.inline.state.textColorBgr, 0x563412);
    assert.equal(graph.inline.state.hideOnReturn, 1);
    assert.equal(graph.inline.state.rejectAscii, 0);
    assert.equal(graph.inline.state.alignment, 1);

    await call(0x20, [10, 20, 120, 20, font, 16, 20, 0]);
    assert.deepEqual(created, [
      {
        face: 'Synthetic',
        height: 16,
        width: 12,
        weight: 100,
        italic: false,
        charset: 0,
        pitchAndFamily: 1,
      },
    ]);
    const element = graph.inline.element;
    assert.ok(element);
    assert.equal(element.tagName, 'INPUT');
    assert.equal(element.value, 'Hello');
    assert.equal(element.style.textAlign, 'center');
    assert.equal(element.style.color, '#123456');
    const frame = element.parent;
    assert.equal(frame.parent, graph.host.parent);
    assert.equal(frame.style.left, '10px');
    assert.equal(frame.style.top, '20px');
    assert.equal(frame.style.width, '120px');
    assert.equal(frame.style.height, '20px');
    assert.equal(frame.hidden, false);

    await call(0x23, [], 1);
    assert.equal(popResult(), 1);
    await call(0x24, [0]);
    assert.equal(frame.hidden, true);
    await call(0x23, [], 1);
    assert.equal(popResult(), 0);
    await call(0x24, [1]);
    assert.equal(frame.hidden, false);
    await call(0x27, [0x300], 1);
    assert.equal(popResult(), 5);
    assert.deepEqual(
      Array.from(memory.globalMemory.subarray(0x300, 0x306)),
      [72, 101, 108, 108, 111, 0],
    );
    await call(0x21, [], 1);
    assert.equal(popResult(), 0);
    assert.equal(graph.inline.element, null);
    assert.equal(graph.inline.target, null);
    assert.equal(frame.parent, null);
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});

test('default graph selects browser font provider for inline EDIT callbacks', async () => {
  const fixture = await createMountedVmFixture();
  try {
    assert.equal(fixture.graph.fonts.browser, fixture.graph.fontProvider);
    assert.equal(
      fixture.definitions.some(
        ({primary, secondary}) => primary === 0xb0 && secondary >= 0x20 && secondary <= 0x2a,
      ),
      true,
    );
  } finally {
    await fixture.close();
  }
});
