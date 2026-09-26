import assert from 'node:assert/strict';
import test from 'node:test';
import {push32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

const folderProfile = {
  shellAllocatorAvailable: true,
  windows: null,
  programFiles: null,
  currentUser: {
    desktop: 'C:\\game\\Desktop',
    programs: 'C:\\game\\Programs',
    documents: null,
    profile: null,
  },
  shellUser: {desktop: null, programs: null, documents: null, profile: null},
  elevated: false,
  shellTokenAvailable: false,
  debugPrivilegeAvailable: false,
  shellAccountName: null,
};

const shortcutPaths = [
  'C:\\game\\Desktop\\Main.lnk',
  'C:\\game\\Programs\\Buriko\\Main.lnk',
  'C:\\game\\Programs\\Buriko\\Uninstall.lnk',
];

async function seededFixture() {
  const fixture = await createMountedVmFixture({specialFolderProfile: folderProfile});
  try {
    const {mounted, graph, encode} = fixture;
    await mounted.createDirectory('/game/Desktop');
    await mounted.createDirectory('/game/Programs');
    await mounted.createDirectory('/game/Programs/Buriko');
    for (const path of shortcutPaths)
      assert.equal(await graph.resource.files.write(encode(path), Uint8Array.of(42)), 1);
    assert.equal(
      await graph.resource.files.write(encode('C:\\game\\Programs\\Other.lnk'), Uint8Array.of(77)),
      1,
    );
    return fixture;
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

for (const removeFolder of [1, 0]) {
  test(`mounted 80:F6 removes three shortcut files and ${removeFolder ? 'the' : 'keeps the'} empty subfolder`, async () => {
    const fixture = await seededFixture();
    const {graph, core, memory, diagnostics, child, definitions, mounted, encode} = fixture;
    try {
      assert.equal(graph.installerShortcutCleanup.folders, graph.folders);
      assert.equal(graph.installerShortcutCleanup.files, graph.resource.files);
      assert.equal(graph.installerShortcutCleanup.metadata, mounted);
      const slots = definitions.filter(
        ({primary, secondary}) => primary === 0x80 && secondary === 0xf6,
      );
      assert.equal(slots.length, 1);
      const [slot] = slots;
      assert.equal(slot.nativeAddress, 0x1400e6160);
      memory.globalMemory.set(encode('Main.lnk'), 0x100);
      memory.globalMemory.set(encode('Uninstall.lnk'), 0x200);
      memory.globalMemory.set(encode('Buriko'), 0x300);
      for (const arg of [0x100, 0x200, 0x300, removeFolder]) push32(child.state, arg);
      const call = slot.execute({thread: child.state, memory, diagnostics});
      assert.ok(call instanceof Promise);
      assert.equal(core.pendingNativeCallbackCount, 1);
      const joined = core.joinPendingNativeCallbacks();
      assert.equal(await call, 0);
      await joined;
      assert.equal(core.pendingNativeCallbackCount, 0);
      assert.equal(child.state.stackIndex, 0); // F6 pushes no BP result.
      assert.equal(child.process, null);
      for (const path of shortcutPaths)
        await assert.rejects(mounted.stat(graph.resource.files.mountedPath(path)), /NOT_FOUND/);
      if (removeFolder) await assert.rejects(mounted.stat('/game/Programs/Buriko'), /NOT_FOUND/);
      else assert.equal((await mounted.stat('/game/Programs/Buriko')).kind, 'directory');
      assert.equal((await mounted.stat('/game/Desktop')).kind, 'directory');
      assert.equal((await mounted.stat('/game/Programs')).kind, 'directory');
      assert.equal((await mounted.stat('/game/Programs/Other.lnk')).kind, 'file');
    } finally {
      await fixture.close();
    }
  });
}
