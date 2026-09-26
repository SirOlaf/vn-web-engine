import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {
  BurikoDevicePower,
  BurikoDevicePowerProfile,
} from '../dist/engines/buriko/native/device-power.js';
import {BurikoBpDiagnostics} from '../dist/engines/buriko/native/diagnostics.js';
import {createGroup81DevicePower} from '../dist/engines/buriko/native/group-81-device-power.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoSystemProfile} from '../dist/engines/buriko/native/system-profile.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

const ansi = (value) => new TextEncoder().encode(value);

function system(platform) {
  return new BurikoSystemProfile({
    readUserName: () => null,
    readComputerName: () => null,
    readVersion: () => ({major: 6, minor: 1, build: 7601, platform, servicePack: ansi('')}),
    readLegacyPhysicalMemory: () => null,
    readPhysicalMemory: () => null,
  });
}

function recordingHost(entries) {
  const profile = new BurikoDevicePowerProfile(entries);
  const calls = [];
  return {
    calls,
    host: {
      openDevice(path, desiredAccess, shareMode, creationDisposition, flagsAndAttributes) {
        calls.push([
          'open',
          path,
          desiredAccess,
          shareMode,
          creationDisposition,
          flagsAndAttributes,
        ]);
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
    },
  };
}

function fixture(platform, entries) {
  const recording = recordingHost(entries);
  const files = new BurikoProgramFiles({}, new BurikoNativeText(), new BurikoProgramMedia());
  const power = new BurikoDevicePower(system(platform), files, recording.host);
  const [definition] = createGroup81DevicePower(power);
  const bytes = new Uint8Array(256).fill(0xa5);
  bytes.set(ansi('C:\\device\0'), 16);
  const memory = new BurikoBpMemory(bytes);
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 16,
    frameCapacity: 16,
  });
  const context = {thread, memory, diagnostics: new BurikoBpDiagnostics(() => {})};
  const invoke = (output = 128) => {
    push32(thread, output);
    push32(thread, 16);
    assert.equal(definition.execute(context), 0);
    const result = pop32(thread);
    assert.equal(thread.stackIndex, 0);
    return result;
  };
  return {...recording, bytes, invoke};
}

test('81 3E bypasses path/open/output entirely for a non-NT platform', () => {
  const {bytes, calls, invoke} = fixture(1, [['C:\\device', 1]]);
  assert.equal(invoke(), 1);
  assert.deepEqual(calls, []);
  assert.deepEqual([...bytes.subarray(128, 132)], [0xa5, 0xa5, 0xa5, 0xa5]);
});

test('81 3E opens with exact flags, writes successful power state and closes', () => {
  const {bytes, calls, invoke} = fixture(2, [['C:\\device', 0xf0000001]]);
  assert.equal(invoke(), 1);
  assert.equal(new DataView(bytes.buffer).getUint32(128, true), 0xf0000001);
  assert.deepEqual(calls, [['open', 'C:\\device', 0x80000000, 1, 3, 0x80], ['query'], ['close']]);
  assert.equal(invoke(0), 1);
  assert.deepEqual(calls.slice(3), [
    ['open', 'C:\\device', 0x80000000, 1, 3, 0x80],
    ['query'],
    ['close'],
  ]);
});

test('device-power open and query failures preserve output with distinct results', () => {
  const missing = fixture(2, []);
  assert.equal(missing.invoke(), 0);
  assert.deepEqual(missing.calls, [['open', 'C:\\device', 0x80000000, 1, 3, 0x80]]);
  assert.deepEqual([...missing.bytes.subarray(128, 132)], [0xa5, 0xa5, 0xa5, 0xa5]);

  const queryFailure = fixture(2, [['C:\\device', null]]);
  assert.equal(queryFailure.invoke(), 1);
  assert.deepEqual(queryFailure.calls, [
    ['open', 'C:\\device', 0x80000000, 1, 3, 0x80],
    ['query'],
    ['close'],
  ]);
  assert.deepEqual([...queryFailure.bytes.subarray(128, 132)], [0xa5, 0xa5, 0xa5, 0xa5]);
});
