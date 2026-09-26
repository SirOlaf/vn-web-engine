import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('80:F3 uses the selected ShellLink owner and rolls back a failed Programs transaction', async () => {
  const saved = [];
  let failSecondPrograms = false;
  const host = {
    createShellLink() {
      let path = '';
      return {
        hresult: 0,
        link: {
          setPath(value) { path = value; return 0; },
          setArguments() { return 0; },
          setWorkingDirectory() { return 0; },
          queryPersistFile() {
            return {
              hresult: 0,
              persist: {
                save(destination) {
                  saved.push([destination, path]);
                  return failSecondPrograms && destination.endsWith('Remove.lnk') ? 1 : 0;
                },
                release() {},
              },
            };
          },
          release() {},
        },
      };
    },
  };
  const folders = {
    desktop: 'C:\\game\\Desktop',
    programs: 'C:\\game\\Programs',
    documents: 'C:\\game',
    profile: 'C:\\game',
  };
  const fixture = await createMountedVmFixture({
    shellShortcutHost: host,
    mountDriveC: true,
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
  try {
    const {graph, memory, child, invoke, definitions} = fixture;
    assert.equal(definitions.filter((slot) => slot.primary === 0x80 && slot.secondary === 0xf3).length, 1);
    const values = [
      'C:\\game', 'aokana.exe', 'Play.lnk', 'uninstall.exe', 'Remove.lnk', 'Aokana',
    ];
    const addresses = values.map((value, index) => {
      const address = 0x100 + index * 0x100;
      memory.globalMemory.set(graph.text.encodeWide(value, 1), address);
      return address;
    });
    failSecondPrograms = true;
    assert.equal(await invoke(0x80, 0xf3, [...addresses, 1, 1], 0), 1);
    assert.equal(pop32(child.state), 0);
    assert.deepEqual(saved, [
      ['C:\\game\\Desktop\\Play.lnk', 'C:\\game\\aokana.exe'],
      ['C:\\game\\Programs\\Aokana\\Play.lnk', 'C:\\game\\aokana.exe'],
      ['C:\\game\\Programs\\Aokana\\Remove.lnk', 'C:\\game\\uninstall.exe'],
    ]);
    await assert.rejects(graph.resource.files.metadata.stat('/game/Programs/Aokana'));
  } finally {
    await fixture.close();
  }
});
