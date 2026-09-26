import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpDiagnostics} from '../dist/engines/buriko/games/aokana/native/diagnostics.js';
import {createGroup81DiskFreeSpace} from '../dist/engines/buriko/games/aokana/native/group-81-disk-free-space.js';
import {
  AokanaDiskFreeSpaceProfile,
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

test('81 37 normalizes the path and writes truncated caller-available MiB', () => {
  const media = new AokanaProgramMedia();
  media.setDriveType(2, 3);
  const files = new AokanaProgramFiles({}, new AokanaNativeText(), media);
  const freeBytes = ((1n << 32n) + 5n) << 20n;
  const host = new AokanaDiskFreeSpaceProfile([['C:\\game\\', freeBytes]]);
  const [definition] = createGroup81DiskFreeSpace(files, host);
  const bytes = new Uint8Array(128).fill(0xa5);
  bytes.set(new TextEncoder().encode('C:\\game\0'), 16);
  const memory = new AokanaBpMemory(bytes);
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 16,
    frameCapacity: 16,
  });
  const context = {thread, memory, diagnostics: new AokanaBpDiagnostics(() => {})};

  push32(thread, 96);
  push32(thread, 16);
  assert.equal(definition.execute(context), 0);
  assert.equal(pop32(thread), 1);
  assert.equal(thread.stackIndex, 0);
  assert.equal(new DataView(bytes.buffer).getUint32(96, true), 5);
  assert.equal(bytes[95], 0xa5);
  assert.equal(bytes[100], 0xa5);
});

test('disk-free-space failures preserve output and do not query unavailable media', () => {
  const media = new AokanaProgramMedia();
  media.setDriveType(3, 5);
  const files = new AokanaProgramFiles({}, new AokanaNativeText(), media);
  const calls = [];
  const host = {
    readFreeBytesAvailable(path) {
      calls.push(path);
      return null;
    },
  };
  const output = {bytes: new Uint8Array([1, 2, 3, 4]), offset: 0};

  assert.equal(
    files.readDiskFreeMegabytes(
      host,
      {bytes: new TextEncoder().encode('D:\\disc\0'), offset: 0},
      output,
    ),
    0,
  );
  assert.deepEqual(calls, []);
  assert.deepEqual([...output.bytes], [1, 2, 3, 4]);

  assert.equal(
    files.readDiskFreeMegabytes(
      host,
      {bytes: new TextEncoder().encode('C:\\fail\\\0'), offset: 0},
      output,
    ),
    0,
  );
  assert.deepEqual(calls, ['C:\\fail\\']);
  assert.deepEqual([...output.bytes], [1, 2, 3, 4]);
});
