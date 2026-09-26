import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpDiagnostics} from '../dist/engines/buriko/native/diagnostics.js';
import {createGroup81NamedMutexes} from '../dist/engines/buriko/native/group-81-named-mutexes.js';
import {BurikoNamedMutexes} from '../dist/engines/buriko/native/named-mutexes.js';
import {textBytes} from '../dist/engines/buriko/native/text.js';

function deterministicHost() {
  const owned = new Map(),
    calls = [],
    host = {
      createOwned(pointer) {
        const name = new TextDecoder().decode(textBytes(pointer, false));
        if (owned.has(name)) {
          const handle = {name, duplicate: true};
          calls.push(['create-duplicate', name, handle]);
          return {handle, lastError: 183};
        }
        const handle = {name};
        owned.set(name, handle);
        calls.push(['create', name, handle]);
        return {handle, lastError: 0};
      },
      release(handle) {
        calls.push(['release', handle.name, handle]);
        owned.delete(handle.name);
      },
      close(handle) {
        calls.push(['close', handle.name, handle]);
      },
    };
  return {host, calls, owned};
}

function writeName(bytes, offset, value) {
  const encoded = new TextEncoder().encode(value);
  bytes.set(encoded, offset);
  bytes[offset + encoded.length] = 0;
}

test('named mutex owner keeps copied newest-first nodes, rejects duplicates and preserves IDs', () => {
  const {host, calls, owned} = deterministicHost(),
    mutexes = new BurikoNamedMutexes(host),
    bytes = new Uint8Array(64),
    memory = new BurikoBpMemory(bytes);
  writeName(bytes, 8, 'alpha');
  writeName(bytes, 24, 'beta');

  assert.equal(mutexes.create(memory.resolve(null, 8)), 1);
  assert.equal(mutexes.create(memory.resolve(null, 24)), 2);
  assert.deepEqual(mutexes.ids, [2, 1]);
  bytes[8] = 88;
  assert.deepEqual([...mutexes.name(1)], [97, 108, 112, 104, 97, 0]);
  bytes[8] = 97;
  assert.equal(mutexes.create(memory.resolve(null, 8)), 0);
  assert.deepEqual(mutexes.ids, [2, 1]);
  assert.equal(calls.at(-1)[0], 'close');
  assert.equal(calls.at(-1)[2].duplicate, true);

  assert.equal(mutexes.release(99), 0);
  assert.equal(mutexes.release(1), 1);
  assert.deepEqual(
    calls.slice(-2).map(([kind, name]) => [kind, name]),
    [
      ['release', 'alpha'],
      ['close', 'alpha'],
    ],
  );
  mutexes.clear();
  assert.deepEqual(mutexes.ids, []);
  assert.equal(owned.size, 0);
  assert.equal(mutexes.nextIdSource, 2);
  assert.equal(mutexes.create(memory.resolve(null, 24)), 3);
});

test('81 EC/ED preserve native argument pops and raw result pushes', () => {
  const {host} = deterministicHost(),
    mutexes = new BurikoNamedMutexes(host),
    definitions = createGroup81NamedMutexes(mutexes),
    handlers = new Map(definitions.map((slot) => [slot.secondary, slot.execute])),
    bytes = new Uint8Array(64),
    memory = new BurikoBpMemory(bytes),
    thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 16,
      frameCapacity: 16,
    }),
    context = {thread, memory, diagnostics: new BurikoBpDiagnostics(() => {})},
    call = (secondary, argument) => {
      push32(thread, argument);
      assert.equal(handlers.get(secondary)(context), 0);
      return pop32(thread);
    };
  writeName(bytes, 12, 'vm-mutex');

  const id = call(0xec, 12);
  assert.equal(id, 1);
  assert.equal(call(0xec, 12), 0);
  assert.equal(call(0xed, id), 1);
  assert.equal(call(0xed, id), 0);
  assert.equal(thread.stackIndex, 0);
});
