import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted 81:06 uses only the explicitly supplied crypto source', async () => {
  let draws = 0;
  const cryptoRandom = {
    getRandomValues(output) {
      assert.ok(output instanceof Uint32Array);
      assert.equal(output.length, 1);
      draws++;
      output[0] = 0xffffffff;
      return output;
    },
  };
  const fixture = await createMountedVmFixture({cryptoRandom});
  const {graph, definitions, child, memory, diagnostics, core} = fixture;
  try {
    assert.equal(graph.cryptoRandom, cryptoRandom);
    const matches = definitions.filter(
      ({primary, secondary}) => primary === 0x81 && secondary === 0x06,
    );
    assert.equal(matches.length, 1);
    const [definition] = matches;
    for (const [bound, expected, count] of [
      [0, 0, 0],
      [10, 5, 1],
      [-10, 0xfffffffb, 2],
      [-2147483648, 0x80000001, 3],
      [1, 0, 4],
    ]) {
      push32(child.state, bound);
      assert.equal(definition.execute({thread: child.state, memory, diagnostics}), 0);
      assert.equal(pop32(child.state), expected);
      assert.equal(draws, count);
      assert.equal(child.state.stackIndex, 0);
      assert.equal(child.process, null);
      assert.equal(core.pendingNativeCallbackCount, 0);
    }
  } finally {
    await fixture.close();
  }
});

test('mounted catalog selects browser crypto for 81:06', async () => {
  const fixture = await createMountedVmFixture();
  try {
    assert.equal(typeof fixture.graph.cryptoRandom?.getRandomValues, 'function');
    assert.equal(
      fixture.definitions.some(({primary, secondary}) => primary === 0x81 && secondary === 0x06),
      true,
    );
  } finally {
    await fixture.close();
  }
});
