import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

const bytes = (value) => new TextEncoder().encode(value);

test('mounted 81:F2 installs through the VM scheduler and shared graph owners', async () => {
  const fixture = await createMountedVmFixture({mountDriveC: true});
  const {graph, core, definitions, memory, child, encode, invoke} = fixture;
  try {
    const service = core.installation;
    assert.equal(service.resources, graph.resource.resources);
    assert.equal(service.loading, graph.resource.loading);
    assert.equal(service.procedures, fixture.data.procedureState);
    assert.equal(service.clock, graph.clock);
    assert.equal(service.notifications, graph.notifications);
    assert.equal(service.registry, graph.registry);
    assert.equal(
      definitions.filter(({primary, secondary}) => primary === 0x81 && secondary === 0xf2).length,
      1,
    );

    const payload = bytes('mounted installation payload');
    await graph.resource.files.write(encode('C:\\game\\disc.id'), bytes('disc'));
    await graph.resource.files.write(encode('C:\\game\\data.bin'), payload);
    await graph.resource.files.write(encode('C:\\game\\uninstall.exe'), bytes('uninstaller'));

    const addresses = {
      destination: 0x100,
      file: 0x180,
      files: 0x1c0,
      counts: 0x200,
      probe: 0x240,
      probes: 0x280,
      retry: 0x2c0,
      retries: 0x300,
      format: 0x340,
      publisher: 0x380,
      product: 0x3c0,
      uninstaller: 0x400,
      uninstallerRetry: 0x440,
    };
    const write = (address, value) => memory.globalMemory.set(bytes(value + '\0'), address);
    const dword = (address, value) =>
      new DataView(memory.globalMemory.buffer).setUint32(address, value, true);
    write(addresses.destination, 'C:\\restart\\install');
    write(addresses.file, 'data.bin');
    dword(addresses.files, addresses.file);
    dword(addresses.files + 4, 0);
    dword(addresses.counts, 1);
    write(addresses.probe, 'disc.id');
    dword(addresses.probes, addresses.probe);
    write(addresses.retry, 'Insert disc');
    dword(addresses.retries, addresses.retry);
    write(addresses.format, 'Component%.4d.CAD');
    write(addresses.publisher, 'Sprite');
    write(addresses.product, 'Aokana');
    write(addresses.uninstaller, 'uninstall.exe');
    write(addresses.uninstallerRetry, 'Insert uninstaller');

    await invoke(
      0x81,
      0xf2,
      [
        addresses.destination,
        0,
        addresses.files,
        1,
        addresses.counts,
        addresses.probes,
        addresses.retries,
        0,
        addresses.format,
        addresses.publisher,
        addresses.product,
        addresses.uninstaller,
        addresses.uninstallerRetry,
      ],
      2,
    );
    assert.notEqual(child.process, null);
    assert.equal(graph.resource.loading.activeProcedures, 1);
    let result = 0;
    for (let count = 0; result === 0; count++) {
      assert.ok(count < 32, 'mounted installation did not finish');
      result = await child.pollProcess(false);
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(result, 1);
    assert.equal(pop32(child.state), 0);
    assert.equal(graph.resource.loading.activeProcedures, 0);

    const installed = await graph.resource.files.open(encode('C:\\restart\\install\\data.bin'));
    assert.notEqual(installed.source, null);
    assert.deepEqual(new Uint8Array(await installed.source.read(0, installed.source.size)), payload);
    const key = {
      hive: 'HKLM',
      view: '64',
      path: 'Software\\Sprite\\Aokana',
    };
    assert.notEqual(await graph.registry.storage.getValue(key, 'InstalledFolder'), null);
    await fixture.close();
  } finally {
    await fixture.close();
  }
});
