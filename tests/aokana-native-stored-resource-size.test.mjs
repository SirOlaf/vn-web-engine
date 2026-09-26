import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpDiagnostics} from '../dist/engines/buriko/native/diagnostics.js';
import {createGroup81StoredResourceSize} from '../dist/engines/buriko/native/group-81-stored-resource-size.js';
import {BurikoResourceRanges} from '../dist/engines/buriko/native/resource-ranges.js';

test('81 35 pops name then optional archive and pushes the shared stored size', async () => {
  const primaryRoot = Uint8Array.of(1, 0);
  const secondaryRoot = Uint8Array.of(2, 0);
  const calls = [];
  const resources = {
    configuration: {
      primaryRoot,
      secondaryRoot,
      secondaryMediaPath: '',
      searchDirectoriesEnabled: 0,
      searchDirectories: [],
    },
    files: {
      isAvailable: () => true,
      async open(path) {
        calls.push([...path]);
        const present = path[0] === 1 && path[1] === 112;
        return present ? {source: {size: 7}} : {source: null};
      },
    },
    loosePath(root, name) {
      const path = new Uint8Array(1 + name.length);
      path[0] = root[0];
      path.set(name, 1);
      return path;
    },
  };
  const ranges = new BurikoResourceRanges(resources);
  const [definition] = createGroup81StoredResourceSize(ranges);
  const bytes = new Uint8Array(128);
  bytes.set(new TextEncoder().encode('present\0'), 16);
  bytes.set(new TextEncoder().encode('missing\0'), 48);
  const memory = new BurikoBpMemory(bytes);
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 16,
    frameCapacity: 16,
  });
  const context = {thread, memory, diagnostics: new BurikoBpDiagnostics(() => {})};

  push32(thread, 0);
  push32(thread, 16);
  assert.equal(await definition.execute(context), 0);
  assert.equal(pop32(thread), 7);
  assert.equal(thread.stackIndex, 0);

  push32(thread, 0);
  push32(thread, 48);
  assert.equal(await definition.execute(context), 0);
  assert.equal(pop32(thread), 0);
  assert.equal(thread.stackIndex, 0);
  assert.deepEqual(calls, [
    [1, 112, 114, 101, 115, 101, 110, 116, 0],
    [1, 109, 105, 115, 115, 105, 110, 103, 0],
    [2, 109, 105, 115, 115, 105, 110, 103, 0],
  ]);
});
