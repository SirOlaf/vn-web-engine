import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('selected 80:E0/E2/E3 external launch uses shared token, mutex and queued pump owners', async () => {
  const events = [];
  let fixture;
  let target;
  let waits = 0;
  let mutexOpens = 0;
  const handle = (name) => ({name});
  const host = {
    isUserAdministrator: () => true,
    readShellWindowProcessId: () => 321,
    openProcess: () => handle('shell-process'),
    openProcessToken: () => handle('source-token'),
    duplicateTokenEx: () => handle('primary-token'),
    createProcessWithTokenW: (_token, _flags, request) => {
      events.push(['token-create', request.startup.showWindow]);
      return null;
    },
    createProcessW: (request) => {
      events.push(['create', request.currentDirectory]);
      return {process: handle('child-process'), thread: handle('child-thread')};
    },
    waitForInputIdle: () => 0,
    waitForSingleObject: () => {
      const result = waits++ % 2 === 0 ? 0x102 : 0;
      if (result === 0x102)
        fixture.graph.messages.post({target, message: 0x9001, wParam: 0, lParam: 0});
      return result;
    },
    readExitCodeProcess: () => assert.fail('80:E0/E2 have no exit-code output'),
    openMutexA: (_access, _inherit, name) => {
      events.push(['mutex', new TextDecoder().decode(name)]);
      return mutexOpens++ === 0 ? handle('mutex') : null;
    },
    sleep: (milliseconds) => events.push(['sleep', milliseconds]),
    closeHandle: (value) => events.push(['close', value.name]),
    impersonateLoggedOnUser: (token) => {
      events.push(['impersonate', token.name]);
      return true;
    },
    shellExecuteW: (...args) => {
      events.push(['shell', ...args]);
      return 32n;
    },
    revertToSelf: () => {
      events.push(['revert']);
      return true;
    },
  };
  fixture = await createMountedVmFixture({
    externalProcessHost: host,
    shellExecuteHost: host,
    systemProfileHost: {
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
    },
    canvas2dContext: {
      save() {},
      resetTransform() {},
      restore() {},
      set globalAlpha(_) {},
      set globalCompositeOperation(_) {},
      set fillStyle(_) {},
      fillRect() {},
    },
  });
  const {graph, memory, invoke, child} = fixture;
  const received = [];
  target = graph.messages.createTarget();
  graph.messages.bindQueuedNumericTarget(target, (message) => {
    received.push(message.message);
    return true;
  });
  try {
    assert.equal(graph.externalProcesses.shellHost, host);
    assert.equal(graph.externalProcesses.mutexName, graph.externalMutexName);
    assert.equal(graph.externalProcesses.window, graph.externalProcessWindow);
    for (const secondary of [0xe0, 0xe2, 0xe3])
      assert.ok(
        fixture.definitions.some((slot) => slot.primary === 0x80 && slot.secondary === secondary),
      );
    memory.globalMemory.set(new TextEncoder().encode('C:\\game\\\0'), 0x100);
    memory.globalMemory.set(new TextEncoder().encode('helper.exe\0'), 0x180);
    memory.globalMemory.set(new TextEncoder().encode('Launch failed\0'), 0x200);
    memory.globalMemory.set(new TextEncoder().encode('MyApp\0'), 0x280);
    memory.globalMemory.set(new TextEncoder().encode('C:\\game\\readme.txt\0'), 0x300);
    assert.equal(await invoke(0x80, 0xea, [0x280], 0), 0);

    assert.equal(await invoke(0x80, 0xe0, [0x100, 0x180, 0x200, 0], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(mutexOpens, 0);

    assert.equal(await invoke(0x80, 0xe2, [0x100, 0x180, 0x200], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(mutexOpens, 2);
    assert.deepEqual(received, [0x9001, 0x9001]);
    assert.equal(graph.messages.pending, 0);

    assert.equal(await invoke(0x80, 0xe3, [0x300], 0), 1);
    assert.equal(pop32(child.state), 1);
    const impersonate = events.findIndex(([kind]) => kind === 'impersonate');
    assert.deepEqual(events.slice(impersonate, impersonate + 4), [
      ['impersonate', 'primary-token'],
      ['shell', null, 'open', 'C:\\game\\readme.txt', null, null, 1],
      ['revert'],
      ['close', 'primary-token'],
    ]);
    assert.ok(events.some(([kind, value]) => kind === 'sleep' && value === 100));
    assert.deepEqual(
      events.filter(([kind]) => kind === 'mutex').map(([, value]) => value),
      ['Uninstaller for MyApp is executing.\0', 'Uninstaller for MyApp is executing.\0'],
    );
    assert.deepEqual(
      events.filter(([kind]) => kind === 'token-create').map(([, show]) => show),
      [5, 5],
    );
  } finally {
    await fixture.close();
  }
});
