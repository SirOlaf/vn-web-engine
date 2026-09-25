import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted font alias mismatch selects the bound fallback for shared text measurement', async () => {
  const created = [];
  const fontProvider = {
    async queryPitch() {
      return 2;
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
      created.push(parameters.face);
      const fallback = parameters.face === 'Secondary';
      const width = fallback ? 7 : 4;
      const faceName = fallback ? 'Secondary' : 'Unexpected A';
      return {
        faceName,
        familyName: faceName,
        cssFamily: faceName,
        averageWidth: width,
        ascent: 8,
        emSize: 8,
        horizontalScale: 1,
        abc() {
          return [0, width, 0];
        },
        extent() {
          return width;
        },
        rasterText(_value, rasterWidth, height) {
          return {stride: rasterWidth, bytes: new Uint8Array(rasterWidth * height)};
        },
      };
    },
    dispose() {},
  };
  const fixture = await createMountedVmFixture({fontProvider});
  const {graph, memory, child, definitions, invoke} = fixture;
  const bytes = memory.globalMemory;
  const view = new DataView(bytes.buffer);
  const call = async (primary, secondary, args, pushed = 0) => {
    assert.equal(await invoke(primary, secondary, args, 0), pushed);
    assert.equal(child.process, null);
  };
  try {
    assert.equal(graph.fontProvider, fontProvider);
    assert.equal(graph.fonts.browser, fontProvider);
    assert.equal(graph.fontResources.fonts, graph.fonts);
    assert.equal(graph.fontResources.resources, graph.resource.resources);
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0xb0 && [0xc7, 0xc8].includes(secondary))
        .map(({secondary}) => secondary),
      [0xc7, 0xc8],
    );
    assert.equal(graph.device.isPresent(), false);

    bytes.set(new TextEncoder().encode('Primary\0'), 0x100);
    bytes.set(new TextEncoder().encode('Expected A\0'), 0x140);
    bytes.set(new TextEncoder().encode('Secondary\0'), 0x180);
    bytes.set(new TextEncoder().encode('A\0'), 0x1c0);
    await call(0xb0, 0xc8, [0x100, 0x140]);
    await call(0xb0, 0xc7, [0x100, 0x180]);
    await call(0xb0, 0xc0, [0x100], 1);
    assert.equal(pop32(child.state), 2);
    await call(0xb0, 0xc1, [0x180, 1], 1);
    assert.equal(pop32(child.state), 3);
    assert.equal(child.state.stackIndex, 0);

    await call(0x90, 0x0d, [0xffffffff]);
    await call(0x91, 0x99, [0], 1);
    assert.equal(pop32(child.state), 1);
    await call(0x91, 0x9b, [0x240, 0x1c0, 2, 8, 100, 0, 1], 1);
    assert.equal(pop32(child.state), 0);
    assert.deepEqual(created, ['Primary', 'Secondary']);
    assert.equal(view.getInt32(0x240, true), 7);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    assert.equal(graph.device.isPresent(), false);
  } finally {
    await fixture.close();
  }
});

test('default mounted graph selects host font alias and fallback callbacks', async () => {
  const fixture = await createMountedVmFixture();
  try {
    assert.equal(fixture.graph.fonts.browser, fixture.graph.fontProvider);
    assert.deepEqual(
      fixture.definitions
        .filter(({primary, secondary}) => primary === 0xb0 && [0xc7, 0xc8].includes(secondary))
        .map(({secondary}) => secondary),
      [0xc7, 0xc8],
    );
  } finally {
    await fixture.close();
  }
});
