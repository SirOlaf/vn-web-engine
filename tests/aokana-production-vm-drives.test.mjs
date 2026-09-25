import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {
  AokanaDriveTypeProfile,
  AokanaDiskFreeSpaceProfile,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaVolumeLabelProfile} from '../dist/engines/buriko/games/aokana/native/volume-labels.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

const driveSlots = [0x36, 0x37, 0x3d];

test('mounted drive callbacks share the selected media, files and volume-label host', async () => {
  const types = new AokanaDriveTypeProfile([0, 0, 3, 5, ...Array(22).fill(0)]);
  const free = new AokanaDiskFreeSpaceProfile([['C:\\game\\', ((1n << 32n) + 5n) << 20n]]);
  const labels = new AokanaVolumeLabelProfile([[67, new TextEncoder().encode('GAME\0')]]);
  const roots = [];
  const freePaths = [];
  const labelRoots = [];
  const driveHost = {
    readDriveType(root) {
      roots.push(root);
      return types.readDriveType(root);
    },
    readFreeBytesAvailable(path) {
      freePaths.push(path);
      return free.readFreeBytesAvailable(path);
    },
    readVolumeLabel(root, output, capacity) {
      labelRoots.push({root: [...root], capacity});
      return labels.readVolumeLabel(root, output, capacity);
    },
  };
  const fixture = await createMountedVmFixture({driveHost});
  const {graph, media, child, definitions, memory, diagnostics, encode, core} = fixture;
  const call = (secondary, args) => {
    const definition = definitions.find(
      ({primary, secondary: value}) => primary === 0x81 && value === secondary,
    );
    assert.ok(definition);
    for (const value of args) push32(child.state, value);
    assert.equal(definition.execute({thread: child.state, memory, diagnostics}), 0);
    assert.equal(child.state.stackIndex, 1);
    const value = pop32(child.state);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    assert.equal(core.pendingNativeCallbackCount, 0);
    return value;
  };
  try {
    assert.equal(graph.resource.driveHost, driveHost);
    assert.equal(graph.resource.media, media);
    assert.equal(graph.resource.files.media, media);
    assert.equal(graph.resource.volumeLabels.host, driveHost);
    assert.deepEqual(
      definitions
        .filter(({primary, secondary}) => primary === 0x81 && driveSlots.includes(secondary))
        .map(({secondary}) => secondary),
      driveSlots,
    );

    memory.globalMemory.fill(0xa5, 0x3ff, 0x469);
    assert.equal(call(0x36, [0x400]), 2);
    assert.deepEqual(
      roots,
      Array.from({length: 26}, (_, index) => `${String.fromCharCode(65 + index)}:\\`),
    );
    assert.deepEqual([...media.driveTypes], [0, 0, 3, 5, ...Array(22).fill(0)]);
    assert.deepEqual([...media.probeDrives], [1, 1, 0, 1, ...Array(22).fill(1)]);
    const view = new DataView(memory.globalMemory.buffer);
    assert.deepEqual(
      Array.from({length: 26}, (_, index) => view.getUint32(0x400 + index * 4, true)),
      [0, 0, 1, 4, ...Array(22).fill(0)],
    );
    assert.equal(memory.globalMemory[0x3ff], 0xa5);
    assert.equal(memory.globalMemory[0x468], 0xa5);

    memory.globalMemory.set(encode('C:\\game'), 0x100);
    memory.globalMemory.fill(0xa5, 0x4ff, 0x505);
    assert.equal(call(0x37, [0x500, 0x100]), 1);
    assert.deepEqual(freePaths, ['C:\\game\\']);
    assert.equal(view.getUint32(0x500, true), 5);
    assert.equal(memory.globalMemory[0x4ff], 0xa5);
    assert.equal(memory.globalMemory[0x504], 0xa5);

    memory.globalMemory.set(encode('Cignored'), 0x180);
    memory.globalMemory.fill(0xa5, 0x5ff, 0x606);
    assert.equal(call(0x3d, [0x600, 0x180]), 1);
    assert.deepEqual(labelRoots, [{root: [67, 58, 92, 0], capacity: 0x30c}]);
    assert.deepEqual([...memory.globalMemory.subarray(0x600, 0x606)], [71, 65, 77, 69, 0, 0xa5]);
    assert.equal(memory.globalMemory[0x5ff], 0xa5);
  } finally {
    await fixture.close();
  }
});

test('mounted catalog selects browser no-drive callbacks', async () => {
  const fixture = await createMountedVmFixture();
  try {
    assert.ok(fixture.graph.resource.driveHost);
    assert.ok(fixture.graph.resource.volumeLabels);
    assert.equal(
      fixture.definitions.some(
        ({primary, secondary}) => primary === 0x81 && driveSlots.includes(secondary),
      ),
      true,
    );
  } finally {
    await fixture.close();
  }
});
