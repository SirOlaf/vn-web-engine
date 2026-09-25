import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted monochrome text draws packed glyphs through the graph surface and font owners', async () => {
  const created = [];
  const fontProvider = {
    async queryPitch() {
      return null;
    },
    async queryCharset() {
      return 128;
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
        rasterMonochrome(value, width, height) {
          assert.equal(width, 32);
          assert.equal(height, 8);
          const stride = 4;
          const bytes = new Uint8Array(stride * height);
          if (value === 'A') bytes[0] = 0x80;
          else if (value === '漢') bytes[stride] = 0x40;
          else assert.fail('ordinary fixture glyph');
          return {bytes, stride};
        },
      };
    },
    dispose() {},
  };
  const fixture = await createMountedVmFixture({fontProvider});
  const {graph, child, definitions, memory, invoke} = fixture;
  const output = new DataView(memory.globalMemory.buffer);
  const call = async (primary, secondary, args, pushes = 0) => {
    assert.equal(await invoke(primary, secondary, args, 0), pushes);
    assert.equal(child.state.stackIndex, pushes);
    assert.equal(child.process, null);
  };
  try {
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x92 && secondary === 0x1e)
        .map(({secondary}) => secondary),
      [0x1e],
    );
    assert.equal(graph.fontProvider, fontProvider);
    assert.equal(graph.fonts.browser, fontProvider);
    assert.equal(graph.monochromeText.surfaces, graph.surfaces);
    assert.equal(graph.surfaces.fonts, graph.fonts);
    assert.equal(graph.resource.errors.files.text, graph.text);
    assert.equal(graph.device.isPresent(), false);
    assert.equal(graph.manager.configureDescriptor(16, 16, 1, 16 * 16), 1);

    memory.globalMemory.set(graph.text.encodeWide('等幅', 0), 0x100);
    memory.globalMemory.set(graph.text.encodeWide('A\x03\x32\n漢\x04AA', 1), 0x180);
    await call(0xb0, 0xc1, [0x100, 0], 1);
    const font = pop32(child.state);
    assert.equal(font, 0);
    await call(0x90, 0x11, [1, 16, 16, 1]);
    await call(0x90, 0x13, [1, 0]);
    await call(0x92, 0x1e, [1, 0, 0, 0x180, font, 8, 1, 1, 0x203040], 1);
    assert.equal(pop32(child.state), 24);
    assert.deepEqual(created, [
      {
        face: '等幅',
        height: 8,
        width: 4,
        weight: 700,
        italic: false,
        charset: 128,
        pitchAndFamily: 1,
      },
    ]);
    const colored = new Set([0, 5 * 16 + 1, 4 * 16 + 9, 8 * 16]);
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        await call(0x92, 0x17, [0x300, 1, x, y], 1);
        assert.equal(pop32(child.state), 0);
        assert.equal(output.getUint32(0x300, true), colored.has(y * 16 + x) ? 0x203040 : 0);
      }
    assert.equal(graph.device.isPresent(), false);
    await call(0x90, 0x12, [1], 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(child.state.stackIndex, 0);
  } finally {
    await fixture.close();
  }
});

test('mounted graph without a selected font provider omits monochrome Surface text', async () => {
  const fixture = await createMountedVmFixture();
  try {
    assert.equal(
      fixture.definitions.some(({primary, secondary}) => primary === 0x92 && secondary === 0x1e),
      false,
    );
  } finally {
    await fixture.close();
  }
});
