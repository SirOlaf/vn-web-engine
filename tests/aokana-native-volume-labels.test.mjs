import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpDiagnostics} from '../dist/engines/buriko/native/diagnostics.js';
import {createGroup81VolumeLabels} from '../dist/engines/buriko/native/group-81-volume-labels.js';
import {
  BurikoVolumeLabelProfile,
  BurikoVolumeLabels,
} from '../dist/engines/buriko/native/volume-labels.js';

test('81 3D uses only the first drive byte, the exact ANSI root and raw host result', () => {
  const profile = new BurikoVolumeLabelProfile([[0xe9, Uint8Array.of(0x82, 0xa0, 0)]]);
  const calls = [];
  const host = {
    readVolumeLabel(root, output, capacity) {
      calls.push({root: [...root], capacity});
      return profile.readVolumeLabel(root, output, capacity) === 0 ? 0 : 0xf0000001;
    },
  };
  const labels = new BurikoVolumeLabels(host);
  const [definition] = createGroup81VolumeLabels(labels);
  const bytes = new Uint8Array(1024).fill(0xa5);
  bytes.set([0xe9, 0x58, 0x59, 0], 16);
  const memory = new BurikoBpMemory(bytes);
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 16,
    frameCapacity: 16,
  });
  const context = {thread, memory, diagnostics: new BurikoBpDiagnostics(() => {})};

  push32(thread, 128);
  push32(thread, 16);
  assert.equal(definition.execute(context), 0);
  assert.equal(pop32(thread), 0xf0000001);
  assert.equal(thread.stackIndex, 0);
  assert.deepEqual(calls, [{root: [0xe9, 58, 92, 0], capacity: 0x30c}]);
  assert.deepEqual([...bytes.subarray(128, 132)], [0x82, 0xa0, 0, 0xa5]);

  assert.equal(profile.readVolumeLabel(Uint8Array.of(0xe9, 58, 92, 0), null, 0x30c), 1);

  const untouched = new Uint8Array([1, 2, 3, 4]);
  assert.equal(
    new BurikoVolumeLabels(new BurikoVolumeLabelProfile([])).read(
      {bytes: untouched, offset: 0},
      {bytes: Uint8Array.of(67), offset: 0},
    ),
    0,
  );
  assert.deepEqual([...untouched], [1, 2, 3, 4]);
});
