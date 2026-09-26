import assert from 'node:assert/strict';
import {test} from 'node:test';
import {instantiateEmbeddedWasm} from '../dist/core/wasm.js';
import {subscribeRuntimeAdvisories} from '../dist/platform/runtime-advisories.js';

test('a failed WebAssembly kernel reaches viewers that subscribe after startup', () => {
  assert.equal(instantiateEmbeddedWasm('AA=='), null);
  const received = [];
  const unsubscribe = subscribeRuntimeAdvisories((advisory) => received.push(advisory));
  try {
    assert.deepEqual(
      received.map(({id}) => id),
      ['wasm-fallback'],
    );
    assert.match(received[0].message, /JavaScript instead of WebAssembly/);
    assert.equal(instantiateEmbeddedWasm('AQ=='), null);
    assert.equal(received.length, 1);
  } finally {
    unsubscribe();
  }
});
