import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaBpDiagnostics} from '../dist/engines/buriko/games/aokana/native/diagnostics.js';
import {createGroup81Drives} from '../dist/engines/buriko/games/aokana/native/group-81-drives.js';
import {
  AokanaDriveTypeProfile,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';

test('81 36 refreshes the shared 26-drive tables and writes every native classification', () => {
  const types = [0, 1, 2, 3, 4, 5, 6, 7, ...Array(18).fill(0xffffffff)],
    profile = new AokanaDriveTypeProfile(types),
    roots = [],
    host = {
      readDriveType(root) {
        roots.push(root);
        return profile.readDriveType(root);
      },
    },
    media = new AokanaProgramMedia(),
    [definition] = createGroup81Drives(media, host),
    bytes = new Uint8Array(192).fill(0xa5),
    memory = new AokanaBpMemory(bytes),
    thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 16,
      frameCapacity: 16,
    }),
    context = {thread, memory, diagnostics: new AokanaBpDiagnostics(() => {})};

  push32(thread, 64);
  assert.equal(definition.execute(context), 0);
  assert.equal(pop32(thread), 5);
  assert.equal(thread.stackIndex, 0);
  assert.deepEqual(
    roots,
    Array.from({length: 26}, (_, index) => `${String.fromCharCode(65 + index)}:\\`),
  );
  assert.deepEqual(
    [...media.driveTypes],
    types.map((value) => value >>> 0),
  );
  assert.deepEqual(
    [...media.probeDrives],
    types.map((value) => Number(value >>> 0 !== 3)),
  );
  const view = new DataView(bytes.buffer, 64, 104),
    classifications = Array.from({length: 26}, (_, index) => view.getUint32(index * 4, true));
  assert.deepEqual(classifications.slice(0, 8), [0, 0, 2, 1, 3, 4, 5, 0]);
  assert.deepEqual(classifications.slice(8), Array(18).fill(0));
  assert.equal(bytes[63], 0xa5);
  assert.equal(bytes[168], 0xa5);
});
