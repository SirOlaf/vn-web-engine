import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaDevicePowerProfile} from '../dist/engines/buriko/games/aokana/native/device-power.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted 81:3E reads selected in-memory device power through one system profile', async () => {
  const calls = [];
  const profile = new AokanaDevicePowerProfile([['C:\\device', 0xf0000001]]);
  const devicePowerHost = {
    openDevice(path, desiredAccess, shareMode, creationDisposition, flagsAndAttributes) {
      calls.push(['open', path, desiredAccess, shareMode, creationDisposition, flagsAndAttributes]);
      return profile.openDevice(
        path,
        desiredAccess,
        shareMode,
        creationDisposition,
        flagsAndAttributes,
      );
    },
    queryDevicePowerState(handle) {
      calls.push(['query']);
      return profile.queryDevicePowerState(handle);
    },
    closeDevice(handle) {
      calls.push(['close']);
      profile.closeDevice(handle);
    },
  };
  const systemProfileHost = {
    readUserName: () => null,
    readComputerName: () => null,
    readVersion: () => {
      calls.push(['version']);
      return {major: 6, minor: 1, build: 7601, platform: 2, servicePack: new Uint8Array()};
    },
    readLegacyPhysicalMemory: () => null,
    readPhysicalMemory: () => null,
  };
  const fixture = await createMountedVmFixture({systemProfileHost, devicePowerHost});
  const {graph, child, definitions, memory, invoke, encode} = fixture;
  try {
    assert.equal(graph.devicePowerHost, devicePowerHost);
    assert.equal(graph.devicePower.host, devicePowerHost);
    assert.equal(graph.devicePower.system, graph.systemProfile);
    assert.equal(graph.systemProfile.host, systemProfileHost);
    assert.equal(graph.devicePower.files, graph.resource.files);
    assert.equal(
      definitions.filter(({primary, secondary}) => primary === 0x81 && secondary === 0x3e).length,
      1,
    );

    memory.globalMemory.set(encode('C:\\device'), 0x180);
    assert.equal(await invoke(0x81, 0x3e, [0x200, 0x180], 0), 1);
    assert.equal(pop32(child.state), 1);
    assert.equal(new DataView(memory.globalMemory.buffer).getUint32(0x200, true), 0xf0000001);
    assert.deepEqual(calls, [
      ['version'],
      ['open', 'C:\\device', 0x80000000, 1, 3, 0x80],
      ['query'],
      ['close'],
    ]);
    assert.equal(child.state.stackIndex, 0);
    assert.equal(child.process, null);
  } finally {
    await fixture.close();
  }
});

test('mounted partial catalog omits 81:3E without a selected device-power host', async () => {
  const fixture = await createMountedVmFixture();
  try {
    assert.equal(fixture.graph.systemProfile, null);
    assert.equal(fixture.graph.devicePowerHost, null);
    assert.equal(fixture.graph.devicePower, null);
    assert.equal(
      fixture.definitions.some(({primary, secondary}) => primary === 0x81 && secondary === 0x3e),
      false,
    );
  } finally {
    await fixture.close();
  }
});
