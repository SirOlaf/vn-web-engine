import test from 'node:test';
import assert from 'node:assert/strict';
import {runtime} from './sc3-fixtures.mjs';
import {NoahState} from '../dist/engines/mages/games/chaos-head-noah/sc3/noah-state.js';
import {
  initializeApplicationState,
  initializeDisplaySettings,
  initializeMovieState,
} from '../dist/engines/mages/games/chaos-head-noah/sc3/application-init.js';
import {NOAH_PATHS} from '../dist/engines/mages/games/chaos-head-noah/paths.js';

test('boot publishes application defaults before executing any script', async () => {
  const vm = runtime([0, 3]);
  await vm.boot();
  const s = vm.state;
  assert.equal(vm.trace.length, 0);
  assert.equal(s.get(0x587348), 255);
  assert.equal(s.get(0x17add48), 47677);
  assert.deepEqual(
    Array.from({length: 48}, (_, i) => s.get(0x179cc20 + i * 4)),
    Array.from({length: 48}, (_, i) => i),
  );
  assert.deepEqual(
    Array.from({length: 16}, (_, i) => s.get(0x20ddf0 + i * 4)),
    [1, ...Array(15).fill(65535)],
  );
  for (let i = 0; i < 10; i++) {
    const d = 0x1d90900 + i * 0x5218;
    assert.equal(s.view(d + 0x18, 4).getFloat32(0, true), 1);
    assert.equal(s.get(0x5a7110 + i * 0x98), -1);
  }
});

test('application initialization preserves holes and does not replay PE data defaults', () => {
  const s = new NoahState(() => {
    throw Error('unexpected RNG');
  });
  s.put(0x20bba8, 7);
  s.put(0x20ddf4, 12);
  s.put(0x5a6f70, 123);
  s.put(0x5a6f98, 456);
  initializeApplicationState(s);
  assert.equal(s.get(0x20bba8), 7);
  assert.equal(s.get(0x20ddf4), 12);
  assert.equal(s.get(0x5a6f70), 123);
  assert.equal(s.get(0x5a6f98), 456);
  assert.equal(s.view(0x873178, 8).getBigUint64(0, true), 0x141023a50n);
  assert.equal(s.view(0x1023b50, 8).getBigUint64(0, true), 0x141762020n);
  s.bytes(0x5a6e10, 96).fill(0xa5);
  initializeMovieState(s);
  for (const a of [0x5a6e10, 0x5a6e20, 0x5a6e30, 0x5a6e40, 0x5a6e60])
    assert.ok(s.bytes(a, 16).every((v) => v === 0));
  assert.ok(s.bytes(0x5a6e50, 16).every((v) => v === 0xa5));
});

test('display projection follows native boolean conversion and int32 subtraction', () => {
  const s = new NoahState(() => 0),
    config = new Uint8Array(0x94),
    v = new DataView(config.buffer);
  for (const mode of [0, 1, -1, 256])
    for (const size of [0, 1, 2, -1, 0x7fffffff, -0x80000000]) {
      v.setInt32(0x34, mode, true);
      v.setInt32(0x38, size, true);
      initializeDisplaySettings(s, config);
      assert.equal(s.get(0x17abc08), mode === 0 ? 0 : 1);
      assert.equal(s.get(0x17abdac), (2 - size) | 0);
    }
});

test('missing CONFIG reaches the native reset flag; an existing empty file does not', async () => {
  for (const present of [false, true]) {
    const vm = runtime([0x10, 0, 0xe0, 0, 0, 0, 0, 0, 0, 0, 3]);
    delete vm.options.configEnabled;
    if (present)
      await vm.platform.windowsFiles.commit([
        {kind: 'write', path: NOAH_PATHS.config, data: new Uint8Array()},
      ]);
    await vm.boot();
    assert.equal(vm.storage.configurationMissing, !present);
    assert.equal(vm.state.get(0x17abdac), present ? 2 : 0);
    assert.equal(vm.runFrame(), 'complete');
    assert.equal(vm.state.flag(0x725), present ? 0 : 1);
  }
});

test('persisted display settings are projected during boot', async () => {
  const vm = runtime([0, 3]),
    config = new Uint8Array(0x6c),
    v = new DataView(config.buffer);
  v.setInt32(0x34, 1, true);
  v.setInt32(0x38, 1, true);
  await vm.platform.windowsFiles.commit([{kind: 'write', path: NOAH_PATHS.config, data: config}]);
  await vm.boot();
  assert.equal(vm.state.get(0x17abc08), 1);
  assert.equal(vm.state.get(0x17abdac), 1);
});
