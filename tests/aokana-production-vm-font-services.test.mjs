import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted font enumeration registers the selected face for measurement and pitch', async () => {
  const enumerationCalls = [];
  const pitchCalls = [];
  const created = [];
  const fontProvider = {
    async queryPitch(name) {
      pitchCalls.push(name);
      return name === 'Synthetic' ? 2 : null;
    },
    async queryCharset() {
      return 1;
    },
    async enumerate(charset, japanese) {
      enumerationCalls.push([charset, japanese]);
      return ['Synthetic'];
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
        averageWidth: 4,
        ascent: 8,
        emSize: 8,
        horizontalScale: 1,
        abc() {
          return [0, 4, 0];
        },
        extent() {
          return 4;
        },
        rasterText(_value, width, height) {
          return {stride: width, bytes: new Uint8Array(width * height)};
        },
      };
    },
    dispose() {},
  };
  const fixture = await createMountedVmFixture({fontProvider});
  const {graph, memory, child, definitions, invoke} = fixture;
  const bytes = memory.globalMemory;
  const view = new DataView(bytes.buffer);
  const call = async (primary, secondary, args) => {
    assert.equal(await invoke(primary, secondary, args, 0), 1);
    const result = pop32(child.state);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    return result;
  };
  try {
    assert.equal(graph.fontProvider, fontProvider);
    assert.equal(graph.fonts.browser, fontProvider);
    assert.equal(graph.fontResources.fonts, graph.fonts);
    assert.equal(graph.fontResources.resources, graph.resource.resources);
    assert.deepEqual(
      definitions
        .filter(
          ({primary, secondary}) => primary === 0xb0 && [0xc4, 0xc5, 0xc6].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0xc4, 0xc5, 0xc6],
    );
    assert.equal(graph.device.isPresent(), false);

    assert.equal(await call(0xb0, 0xc5, [0x100, 1]), 1);
    assert.deepEqual(
      [...bytes.subarray(0x100, 0x10a)],
      [...new TextEncoder().encode('Synthetic\0')],
    );
    assert.deepEqual(enumerationCalls, [[1, false]]);
    assert.equal(await call(0xb0, 0xc0, [0x100]), 0);
    assert.deepEqual([...graph.fonts.name(0)], [...new TextEncoder().encode('Synthetic')]);

    assert.equal(await invoke(0x90, 0x0d, [0xffffffff], 0), 0);
    assert.equal(child.process, null);
    bytes.set(new TextEncoder().encode('A\0'), 0x180);
    assert.equal(await call(0x91, 0x9b, [0x240, 0x180, 0, 8, 100, 0, 0]), 0);
    assert.equal(view.getInt32(0x240, true), 4);
    assert.equal(created.length, 1);
    assert.equal(created[0].face, 'Synthetic');
    assert.equal(Math.abs(created[0].height), 8);

    assert.equal(await call(0xb0, 0xc6, [0x300, 0x100]), 1);
    assert.equal(view.getInt32(0x300, true), 2);
    assert.deepEqual(pitchCalls, ['Synthetic']);

    assert.equal(await call(0xb0, 0xc4, [0x400]), 3);
    assert.deepEqual(enumerationCalls, [
      [1, false],
      [128, false],
    ]);
    assert.deepEqual(
      [...bytes.subarray(0x400, 0x41e)],
      [...new TextEncoder().encode('Synthetic\0MS Gothic\0MS Mincho\0')],
    );
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    assert.equal(graph.device.isPresent(), false);
  } finally {
    await fixture.close();
  }
});

test('default mounted graph selects host font enumeration and pitch callbacks', async () => {
  const fixture = await createMountedVmFixture();
  try {
    assert.equal(fixture.graph.fonts.browser, fixture.graph.fontProvider);
    assert.deepEqual(
      fixture.definitions
        .filter(
          ({primary, secondary}) => primary === 0xb0 && [0xc4, 0xc5, 0xc6].includes(secondary),
        )
        .map(({secondary}) => secondary),
      [0xc4, 0xc5, 0xc6],
    );
  } finally {
    await fixture.close();
  }
});
