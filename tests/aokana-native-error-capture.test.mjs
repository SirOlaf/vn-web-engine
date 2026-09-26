import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpDiagnostics} from '../dist/engines/buriko/games/aokana/native/diagnostics.js';
import {AokanaEngineErrors} from '../dist/engines/buriko/games/aokana/native/engine-errors.js';
import {createGroup81ErrorCapture} from '../dist/engines/buriko/games/aokana/native/group-81-error-capture.js';

test('81 6A/6B share first-error capture and preserve optional inclusive-NUL reads', () => {
  const errors = new AokanaEngineErrors({}, {}, Uint8Array.of(0), Uint8Array.of(0)),
    definitions = createGroup81ErrorCapture(errors),
    handlers = new Map(definitions.map((slot) => [slot.secondary, slot.execute])),
    bytes = new Uint8Array(96).fill(0xa5),
    memory = new AokanaBpMemory(bytes),
    thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 16,
      frameCapacity: 16,
    }),
    context = {thread, memory, diagnostics: new AokanaBpDiagnostics(() => {})};

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
