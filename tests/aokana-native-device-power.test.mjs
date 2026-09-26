import test from 'node:test';
import assert from 'node:assert/strict';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {
  AokanaDevicePower,
  AokanaDevicePowerProfile,
} from '../dist/engines/buriko/games/aokana/native/device-power.js';
import {AokanaBpDiagnostics} from '../dist/engines/buriko/games/aokana/native/diagnostics.js';
import {createGroup81DevicePower} from '../dist/engines/buriko/games/aokana/native/group-81-device-power.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaSystemProfile} from '../dist/engines/buriko/games/aokana/native/system-profile.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';

const ansi = (value) => new TextEncoder().encode(value);

function system(platform) {
  return new AokanaSystemProfile({
    readUserName: () => null,
    readComputerName: () => null,
    readVersion: () => ({major: 6, minor: 1, build: 7601, platform, servicePack: ansi('')}),
    readLegacyPhysicalMemory: () => null,
    readPhysicalMemory: () => null,
  });
}

function recordingHost(entries) {
  const profile = new AokanaDevicePowerProfile(entries);
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
  const files = new AokanaProgramFiles({}, new AokanaNativeText(), new AokanaProgramMedia());
  const power = new AokanaDevicePower(system(platform), files, recording.host);
  const [definition] = createGroup81DevicePower(power);
  const bytes = new Uint8Array(256).fill(0xa5);
  bytes.set(ansi('C:\\device\0'), 16);
  const memory = new AokanaBpMemory(bytes);
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 16,
    frameCapacity: 16,
  });
  const context = {thread, memory, diagnostics: new AokanaBpDiagnostics(() => {})};
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
