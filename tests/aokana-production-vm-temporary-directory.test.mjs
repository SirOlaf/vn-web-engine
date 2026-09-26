import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {
  BurikoBrowserTemporaryFileHost,
  BurikoTemporaryFileProfile,
} from '../dist/engines/buriko/native/temporary-directory-probe.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('temporary directory callback uses the selected browser mounted-file host by default', async () => {
  const fixture = await createMountedVmFixture();
  try {
    assert.ok(fixture.graph.resource.temporaryDirectoryProbe);
    assert.ok(
      fixture.graph.resource.temporaryDirectoryProbe.host instanceof BurikoBrowserTemporaryFileHost,
    );
    assert.equal(
      fixture.definitions.some(({primary, secondary}) => primary === 0x81 && secondary === 0x2f),
      true,
    );
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
