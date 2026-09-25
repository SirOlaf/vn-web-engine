import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted 81:F7 uses the graph folders and selected in-memory ShellLink primitive', async () => {
  const calls = [];
  const shellShortcutHost = {
    createShellLink() {
      calls.push(['create']);
      return {
        hresult: 0,
        link: {
          setPath(path) {
            calls.push(['path', path]);
            return 0;
          },
          setArguments(arguments_) {
            calls.push(['arguments', arguments_]);
            return 0;
          },
          setWorkingDirectory(directory) {
            calls.push(['working-directory', directory]);
            return 0;
          },
          queryPersistFile() {
            calls.push(['query-persist']);
            return {
              hresult: 0,
              persist: {
                save(destination, remember) {
                  calls.push(['save', destination, remember]);
                  return 0;
                },
                release() {
                  calls.push(['release-persist']);
                },
              },
            };
          },
          release() {
            calls.push(['release-link']);
          },
        },
      };
    },
  };
  const folders = {
    desktop: 'C:\\Users\\Player\\Desktop',
    programs: 'C:\\Users\\Player\\Programs',
    documents: 'C:\\Users\\Player\\Documents',
    profile: 'C:\\Users\\Player',
  };
  const fixture = await createMountedVmFixture({
    shellShortcutHost,
    specialFolderProfile: {
      shellAllocatorAvailable: true,
      windows: 'C:\\Windows',
      programFiles: 'C:\\Program Files',
      currentUser: folders,
      shellUser: folders,
      elevated: false,
      shellTokenAvailable: false,
      debugPrivilegeAvailable: false,
      shellAccountName: null,
    },
  });
  const {graph, definitions, memory, child, invoke, core} = fixture;
  try {
    assert.equal(graph.shellShortcutHost, shellShortcutHost);
    assert.equal(graph.shellShortcuts.host, shellShortcutHost);
    assert.equal(graph.shellShortcuts.files, graph.resource.files);
    assert.equal(graph.shellShortcuts.folders, graph.folders);
    assert.equal(graph.resource.files.specialFolders, graph.folders);
    assert.equal(
      definitions.filter(({primary, secondary}) => primary === 0x81 && secondary === 0xf7).length,
      1,
    );
    memory.globalMemory.set(graph.text.encodeWide('Aokana.lnk', 1), 0x100);
    memory.globalMemory.set(graph.text.encodeWide('C:\\game\\aokana.exe', 1), 0x200);
    memory.globalMemory.set(graph.text.encodeWide('--route misaki', 1), 0x300);
    assert.equal(await invoke(0x81, 0xf7, [0, 0x100, 0x200, 0x300], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    assert.equal(core.pendingNativeCallbackCount, 0);
    assert.deepEqual(calls, [
      ['create'],
      ['path', 'C:\\game\\aokana.exe'],
      ['arguments', '--route misaki'],
      ['working-directory', ''],
      ['query-persist'],
      ['save', 'C:\\Users\\Player\\Desktop\\Aokana.lnk', true],
      ['release-persist'],
      ['release-link'],
    ]);
  } finally {
    await fixture.close();
  }
});

test('mounted partial catalog omits 81:F7 without a selected ShellLink host', async () => {
  const fixture = await createMountedVmFixture();
  try {
    assert.equal(fixture.graph.shellShortcutHost, null);
    assert.equal(fixture.graph.shellShortcuts, null);
    assert.equal(
      fixture.definitions.some(({primary, secondary}) => primary === 0x81 && secondary === 0xf7),
      false,
    );
  } finally {
    await fixture.close();
  }
});
