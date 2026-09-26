import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpDiagnostics} from '../dist/engines/buriko/native/diagnostics.js';
import {BurikoEngineErrors} from '../dist/engines/buriko/native/engine-errors.js';
import {createGroup81ErrorCapture} from '../dist/engines/buriko/native/group-81-error-capture.js';

test('81 6A/6B share first-error capture and preserve optional inclusive-NUL reads', () => {
  const errors = new BurikoEngineErrors({}, {}, Uint8Array.of(0), Uint8Array.of(0)),
    definitions = createGroup81ErrorCapture(errors),
    handlers = new Map(definitions.map((slot) => [slot.secondary, slot.execute])),
    bytes = new Uint8Array(96).fill(0xa5),
    memory = new BurikoBpMemory(bytes),
    thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 16,
      frameCapacity: 16,
    }),
    context = {thread, memory, diagnostics: new BurikoBpDiagnostics(() => {})};

  push32(thread, 0x89abcdef);
  assert.equal(handlers.get(0x6a)(context), 0);
  assert.equal(thread.stackIndex, 0);
  assert.equal(errors.captureEnabled, 0x89abcdef);
  assert.equal(errors.getCaptureEnabled(), 0x89abcdef);

  push32(thread, 0);
  assert.equal(handlers.get(0x6b)(context), 0);
  assert.equal(pop32(thread), 0);

  assert.equal(errors.captureFirst(Uint8Array.of(65, 66, 0, 67)), 1);
  assert.equal(errors.captureFirst(Uint8Array.of(88, 0)), 0);
  push32(thread, 0);
  assert.equal(handlers.get(0x6b)(context), 0);
  assert.equal(pop32(thread), 3);

  push32(thread, 32);
  assert.equal(handlers.get(0x6b)(context), 0);
  assert.equal(pop32(thread), 3);
  assert.deepEqual([...bytes.subarray(32, 36)], [65, 66, 0, 0xa5]);
  assert.equal(thread.stackIndex, 0);
});
