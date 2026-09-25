import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('80:F0/F1 use the selected modal form owner and preserve native outputs', async () => {
  const requests = [];
  const installerDialogHost = {
    async chooseDestination(request) {
      requests.push(['destination', request]);
      return {
        result: 1,
        path: request.pathEditable ? 'C:\\restart\\install' : 'ignored because fixed',
        optionA: 1,
        optionB: 0,
      };
    },
    async chooseComponent(request) {
      requests.push(['component', request]);
      return 3;
    },
    async runProgress() { throw new Error('This test does not run installation'); },
  };
  const fixture = await createMountedVmFixture({installerDialogHost, mountDriveC: true});
  try {
    const {graph, memory, definitions, child, invoke} = fixture;
    assert.equal(graph.installerDialogs.host, installerDialogHost);
    assert.equal(graph.installerDialogs.files, graph.resource.files);
    for (const secondary of [0xf0, 0xf1])
      assert.equal(definitions.filter((slot) => slot.primary === 0x80 && slot.secondary === secondary).length, 1);
    const strings = ['C:\\game', 'Game files', 'Description', 'Basic', 'Complete', 'Custom'];
    const addresses = strings.map((value, index) => {
      const address = 0x200 + index * 0x100;
      memory.globalMemory.set(graph.text.encodeWide(value, 1), address);
      return address;
    });
    assert.equal(await invoke(0x80, 0xf0, [0, 0x100, 0x104, addresses[0], 0, 1, addresses[1], addresses[2]], 0), 1);
    assert.equal(pop32(child.state), 1);
    const view = new DataView(memory.globalMemory.buffer);
    assert.equal(view.getUint32(0x100, true), 1);
    assert.equal(view.getUint32(0x104, true), 0);
    assert.equal(requests[0][1].path, 'C:\\game');
    assert.equal(requests[0][1].pathEditable, false);
    assert.equal(requests[0][1].optionA, 0);
    assert.equal(requests[0][1].optionB, 1);
    graph.resource.files.media.driveTypes[2] = 3;
    assert.equal(await invoke(0x80, 0xf0, [0x900, 0x100, 0x104, addresses[0], 0, 1, addresses[1], addresses[2]], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(graph.text.decodeAuto({bytes: memory.globalMemory, offset: 0x900}), 'C:\\restart\\install');
    assert.equal(await invoke(0x80, 0xf1, [addresses[2], addresses[3], addresses[4], addresses[5], 1, 2], 0), 1);
    assert.equal(pop32(child.state), 3);
    assert.deepEqual(requests[2][1].choices, ['Basic', 'Complete', 'Custom']);
    assert.equal(requests[2][1].showSpecialButton, true);
    assert.equal(requests[2][1].disabledChoice, 2);
  } finally {
    await fixture.close();
  }
});
