import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

const bytes = (value) => new TextEncoder().encode(value);

test('80:F2 runs the mounted file and uninstaller transaction in its progress modal', async () => {
  const taskbar = [];
  const reports = [];
  const installerDialogHost = {
    async chooseDestination() { throw new Error('unexpected destination dialog'); },
    async chooseComponent() { throw new Error('unexpected component dialog'); },
    async runProgress(request) {
      assert.equal(request.template, 0x7b);
      assert.equal(request.cancellable, true);
      return Number(await request.run((report) => reports.push(report), () => taskbar.push('dialog')));
    },
  };
  const taskbarProgressHost = {
    createTaskbarList3() {
      taskbar.push('create');
      return {
        setProgressState(owner, state) {
          assert.ok(owner);
          taskbar.push(state);
        },
        release() { taskbar.push('release'); },
      };
    },
  };
  const fixture = await createMountedVmFixture({
    mountDriveC: true,
    installerDialogHost,
    taskbarProgressHost,
  });
  try {
    const {graph, memory, child, definitions, invoke, encode} = fixture;
    assert.equal(definitions.filter((slot) => slot.primary === 0x80 && slot.secondary === 0xf2).length, 1);
    await graph.resource.files.write(encode('C:\\game\\disc.id'), bytes('disc'));
    await graph.resource.files.write(encode('C:\\game\\data.bin'), bytes('installed content'));
    await graph.resource.files.write(encode('C:\\game\\uninstall.exe'), bytes('uninstaller'));
    const address = {
      destination: 0x100, file: 0x180, files: 0x1c0, counts: 0x200,
      probe: 0x240, probes: 0x280, retry: 0x2c0, retries: 0x300,
      format: 0x340, publisher: 0x380, product: 0x3c0,
      uninstaller: 0x400, uninstallerRetry: 0x440,
    };
    const write = (at, value) => memory.globalMemory.set(bytes(value + '\0'), at);
    const dword = (at, value) => new DataView(memory.globalMemory.buffer).setUint32(at, value, true);
    write(address.destination, 'C:\\restart\\install');
    write(address.file, 'data.bin');
    dword(address.files, address.file);
    dword(address.files + 4, 0);
    dword(address.counts, 1);
    write(address.probe, 'disc.id');
    dword(address.probes, address.probe);
    write(address.retry, 'Insert disc');
    dword(address.retries, address.retry);
    write(address.format, 'Component%.4d.CAD');
    write(address.publisher, 'Sprite');
    write(address.product, 'Aokana');
    write(address.uninstaller, 'uninstall.exe');
    write(address.uninstallerRetry, 'Insert uninstaller');
    assert.equal(await invoke(0x80, 0xf2, [
      address.destination, 0, address.files, 1, address.counts,
      address.probes, address.retries, 0, address.format,
      address.publisher, address.product, address.uninstaller,
      address.uninstallerRetry, 1,
    ], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(graph.resource.loading.activeProcedures, 0);
    assert.deepEqual(taskbar, ['create', 2, 'dialog', 0, 'release']);
    assert.ok(reports.some((report) => report.completedFiles === 1 && report.totalFiles === 1));
    const installed = await graph.resource.files.open(encode('C:\\restart\\install\\data.bin'));
    assert.ok(installed.source);
    assert.equal(bytes('installed content').length, installed.source.size);
    assert.ok(await graph.registry.storage.getValue({
      hive: 'HKLM', view: '64', path: 'Software\\Sprite\\Aokana',
    }, 'InstalledFolder'));
  } finally {
    await fixture.close();
  }
});
