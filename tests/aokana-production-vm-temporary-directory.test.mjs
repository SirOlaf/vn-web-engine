import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {OverlayFileSystem, SourceFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {BURIKO_ENGINE_1665} from '../dist/engines/buriko/native/engine-version.js';
import {
  BurikoBrowserTemporaryFileHost,
  BurikoTemporaryFileProfile,
} from '../dist/engines/buriko/native/temporary-directory-probe.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('browser save probe traverses the virtual drive root and preserves the installation directory', async () => {
  const canonical = (path) => path.toLowerCase();
  const driveRootFiles = new SourceFileSystem(canonical);
  driveRootFiles.attachDirectory('/game');
  driveRootFiles.attachDirectory('/UserData');
  const sourceFiles = new OverlayFileSystem(
    new SourceFileSystem(canonical),
    new MemoryStore(),
    canonical,
  );
  await sourceFiles.installDirectories(['/UserData']);
  const fixture = await createMountedVmFixture({
    sourceFiles,
    driveRootFiles,
    engineVersion: BURIKO_ENGINE_1665,
  });
  try {
    assert.ok(fixture.graph.resource.temporaryDirectoryProbe);
    assert.ok(
      fixture.graph.resource.temporaryDirectoryProbe.host instanceof BurikoBrowserTemporaryFileHost,
    );
    const {child, memory, encode, mounted} = fixture;
    memory.globalMemory.set(encode('C:\\game\\UserData'), 0x100);
    await fixture.invoke(0x81, 0x2f, [0x100], 0);
    assert.equal(pop32(child.state), 1);
    assert.deepEqual(
      (await mounted.list('/drive-c')).map(({path}) => path),
      ['/drive-c/game', '/drive-c/userdata'],
    );
    assert.deepEqual(await mounted.list('/game/UserData'), []);
    const output = await fixture.graph.resource.files.createOutput(
      encode('C:\\game\\UserData\\JewelryHeartsAcademia001.sud'),
    );
    assert.notEqual(output, null);
    assert.equal(await output.write(Uint8Array.of(1, 3, 5, 7)), 4);
    output.close();
    const stored = await sourceFiles.open('/UserData/JewelryHeartsAcademia001.sud');
    assert.deepEqual(await stored.read(0, stored.size), Uint8Array.of(1, 3, 5, 7));
  } finally {
    await fixture.close();
  }
});

test('mounted 81:2F probes and removes a temporary file and nested C drive directories', async () => {
  const fixture = await createMountedVmFixture({
    mountDriveC: true,
    temporaryFileHost: new BurikoTemporaryFileProfile(['BGI0001.tmp']),
  });
  const {graph, core, memory, diagnostics, child, definitions, mounted, encode} = fixture;
  try {
    assert.equal(graph.resource.temporaryDirectoryProbe.files, graph.resource.files);
    assert.equal(graph.resource.files.mountedPath('C:\\probe\\nested'), '/drive-c/probe/nested');
    assert.equal(graph.resource.files.mountedPath('C:\\game\\system.arc'), '/game/system.arc');
    const definition = definitions.find(
      ({primary, secondary}) => primary === 0x81 && secondary === 0x2f,
    );
    assert.ok(definition);
    assert.equal(
      definitions.filter(({primary, secondary}) => primary === 0x81 && secondary === 0x2f).length,
      1,
    );
    memory.globalMemory.set(encode('C:\\probe\\nested'), 0x100);
    push32(child.state, 0x100);
    const call = definition.execute({thread: child.state, memory, diagnostics});
    assert.ok(call instanceof Promise);
    assert.equal(core.pendingNativeCallbackCount, 1);
    const joined = core.joinPendingNativeCallbacks();
    assert.equal(await call, 0);
    await joined;
    assert.equal(core.pendingNativeCallbackCount, 0);
    assert.equal(pop32(child.state), 1);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
    assert.deepEqual(await mounted.list('/drive-c'), []);
    assert.deepEqual(
      mounted.snapshot().filter(({path}) => path.startsWith('/drive-c/')),
      [],
    );
  } finally {
    await fixture.close();
  }
});
