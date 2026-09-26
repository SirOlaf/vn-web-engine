import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('selected process and logical-drive slots use the graph resource owner and queued pump', async () => {
  const events = [];
  const driveHost = {
    readLogicalDriveStrings: () => ['C:\\'],
    readDriveType: () => 5,
    readFreeBytesAvailable: () => 0n,
    readVolumeLabel: () => 0,
  };
  const processHandle = {burikoExternalProcessHandle: true, name: 'process'};
  const threadHandle = {burikoExternalProcessHandle: true, name: 'thread'};
  let fixture;
  let waitCount = 0;
  const processHost = {
    isUserAdministrator: () => false,
    readShellWindowProcessId: () => assert.fail('ordinary launch has no shell token'),
    openProcess: () => assert.fail('ordinary launch has no shell token'),
    openProcessToken: () => assert.fail('ordinary launch has no shell token'),
    duplicateTokenEx: () => assert.fail('ordinary launch has no shell token'),
    createProcessWithTokenW: () => assert.fail('ordinary launch has no shell token'),
    createProcessW: (request) => {
      events.push(['create', request.currentDirectory]);
      assert.equal(request.commandLine[0], 34);
      return {process: processHandle, thread: threadHandle};
    },
    waitForInputIdle: () => 0,
    waitForSingleObject: () => {
      if (waitCount++ === 0) {
        fixture.graph.messages.post({target: target, message: 0x9002, wParam: 0, lParam: 0});
        return 0x102;
      }
      return 0;
    },
    readExitCodeProcess: () => 23,
    openMutexA: () => null,
    sleep: async () => {},
    closeHandle: (handle) => events.push(['close', handle.name]),
  };
  const systemProfileHost = {
    readUserName: () => null,
    readComputerName: () => null,
    readVersion: () => ({
      major: 10,
      minor: 0,
      build: 19045,
      platform: 2,
      servicePack: new Uint8Array(),
    }),
    readLegacyPhysicalMemory: () => null,
    readPhysicalMemory: () => null,
  };
  let slept = false;
  fixture = await createMountedVmFixture({
    driveHost,
    logicalDriveHost: driveHost,
    externalProcessHost: processHost,
    systemProfileHost,
    sleep: async (milliseconds) => {
      assert.equal(milliseconds, 100);
      if (slept) return;
      slept = true;
      assert.equal(
        await fixture.graph.resource.files.write(
          fixture.encode('C:\\game\\marker'),
          Uint8Array.of(1),
        ),
        1,
      );
      assert.equal(await fixture.graph.resource.files.hasPathWide('C:\\game\\marker'), true);
      fixture.graph.messages.post({target, message: 0x9001, wParam: 0, lParam: 0});
    },
  });
  const {graph, invoke, memory, encode, child} = fixture;
  const received = [];
  const target = graph.messages.createTarget();
  graph.messages.bindQueuedNumericTarget(target, (message) => {
    received.push(message.message);
    return true;
  });
  try {
    assert.equal(graph.externalProcesses.window, graph.externalProcessWindow);
    assert.equal(graph.secondaryMedia.window, graph.externalProcessWindow);
    assert.equal(graph.secondaryMedia.resources, graph.resource.resources);
    assert.equal(graph.secondaryMedia.drives, graph.resource.driveHost);
    assert.ok(fixture.definitions.some((slot) => slot.primary === 0x80 && slot.secondary === 0x3f));
    assert.ok(fixture.definitions.some((slot) => slot.primary === 0x81 && slot.secondary === 0xe0));

    memory.globalMemory.set(encode('game\\marker'), 0x100);
    memory.globalMemory.set(encode('Media'), 0x180);
    memory.globalMemory.set(encode('Insert media'), 0x200);
    assert.equal(await invoke(0x80, 0x3f, [0x100, 0x180, 0x200, 0], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(graph.resource.resources.configuration.secondaryMediaPath, 'C:\\game\\');
    assert.deepEqual(received, [0x9001]);

    memory.globalMemory.set(new TextEncoder().encode('helper.exe\0'), 0x400);
    assert.equal(await invoke(0x81, 0xe0, [0x300, 0, 0x400, 0, 1, 0, 0], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(new DataView(memory.globalMemory.buffer).getUint32(0x300, true), 23);
    assert.deepEqual(received, [0x9001, 0x9002]);
    assert.deepEqual(events, [
      ['create', 'C:\\game'],
      ['close', 'thread'],
      ['close', 'process'],
    ]);
  } finally {
    await fixture.close();
  }
});
