import test from 'node:test';
import assert from 'node:assert/strict';
import {NoahState} from '../dist/engines/mages/games/chaos-head-noah/sc3/noah-state.js';
import {SaveStorage} from '../dist/engines/mages/games/chaos-head-noah/sc3/save-storage.js';
import {MemoryStore} from '../dist/platform/store.js';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {WindowsFileSystem} from '../dist/platform/windows-filesystem.js';
import {NOAH_PATHS} from '../dist/engines/mages/games/chaos-head-noah/paths.js';
function fixture() {
  const s = new NoahState(() => 0),
    files = new WindowsFileSystem(new StoredFileSystem(new MemoryStore()), {
      cwd: 'C:\\Game',
      mounts: [{windows: 'C:\\', virtual: '/c'}],
    });
  return {s, files, storage: new SaveStorage(s, files)};
}
async function complete(storage) {
  let frames = 0;
  while (storage.state.get(0x1de8bb4)) {
    if (++frames > 20) throw Error('Storage stalled');
    await storage.settle();
    storage.advance();
  }
  return frames;
}
test('system check reports missing or present guest file without creating save data', async () => {
  const {storage, files, s} = fixture();
  assert.equal(storage.begin('check'), 1);
  assert.equal(storage.poll('check'), 1);
  assert.equal(await complete(storage), 4);
  assert.equal(storage.poll('check'), 2);
  assert.equal(s.bytes(0x1bb0379, 1)[0], 1);
  await assert.rejects(files.open(NOAH_PATHS.saveData), /NOT_FOUND/);
  await files.commit([{kind: 'write', path: NOAH_PATHS.saveData, data: new Uint8Array(0)}]);
  storage.begin('check');
  await complete(storage);
  assert.equal(storage.poll('check'), 0);
  assert.equal((await files.open(NOAH_PATHS.saveData)).size, 0);
});
test('save worker persists all three native buffers and read restores their exact order', async () => {
  const {storage, s, files} = fixture();
  for (const [address, length, value] of [
    [0x1762020, 0xc508, 17],
    [0xc4dc10, 0x3d5e40, 34],
    [0x873290, 0x3d5e40, 51],
  ])
    s.writeSpan(address, new Uint8Array(length).fill(value));
  storage.begin('write');
  assert.equal(await complete(storage), 8);
  assert.equal(storage.poll('write'), 0);
  const file = await files.open(NOAH_PATHS.saveData);
  assert.equal(file.size, 0x7b8188);
  assert.deepEqual([...(await file.read(0xc508 - 1, 2))], [17, 34]);
  assert.deepEqual([...(await file.read(0xc508 + 0x3d5e40 - 1, 2))], [34, 51]);
  s.zero(0x1762020, 0xc508);
  s.zero(0xc4dc10, 0x3d5e40);
  s.zero(0x873290, 0x3d5e40);
  storage.begin('read');
  await complete(storage);
  assert.equal(storage.poll('read'), 0);
  assert.equal(s.bytes(0x1762020, 1)[0], 17);
  assert.equal(s.bytes(0xc4dc10, 1)[0], 34);
  assert.equal(s.bytes(0x873290, 1)[0], 51);
});
test('read errors and short reads preserve the existing transfer-buffer tail', async () => {
  const {storage, files, s} = fixture();
  storage.buffer.fill(91);
  await files.commit([{kind: 'write', path: NOAH_PATHS.saveData, data: Uint8Array.of(1, 2)}]);
  storage.begin('read');
  await complete(storage);
  assert.equal(storage.poll('read'), 0);
  assert.deepEqual([...s.bytes(0x1762020, 4)], [1, 2, 91, 91]);
  await files.commit([{kind: 'delete', path: NOAH_PATHS.saveData}]);
  storage.begin('read');
  await complete(storage);
  assert.equal(storage.poll('read'), 2);
  assert.deepEqual([...s.bytes(0x1762020, 4)], [1, 2, 91, 91]);
});
test('configuration uses native file sizes and leaves bytes beyond a short read untouched', async () => {
  const {storage, files} = fixture();
  await storage.initializeConfiguration();
  assert.equal(storage.configuration[0x74], 0);
  assert.equal(storage.configuration[0x75], 1);
  await storage.writeConfiguration();
  assert.equal((await files.open(NOAH_PATHS.config)).size, 108);
  assert.equal((await files.open(NOAH_PATHS.padConfig)).size, 40);
});

import {runtime} from './sc3-fixtures.mjs';
test('blocking config opcode retains its dispatcher continuation and starts save only after both config files', async () => {
  const vm = runtime([0, 42, 60, 0, 3]);
  await vm.boot();
  assert.equal(vm.runFrame(), 'blocked');
  assert.equal(vm.pc(0), 19);
  assert.equal(vm.trace.length, 0);
  assert.equal(vm.runFrame(), 'blocked');
  await vm.waitHost();
  assert.equal(vm.runFrame(), 'complete');
  assert.equal(vm.trace.length, 2);
  assert.equal(vm.trace[0].operation, 'save system');
  assert.equal(vm.trace[0].pc, 16);
  assert.equal(vm.state.variable(0x3414 / 4), 1);
  assert.deepEqual(
    vm.storage.events.map((e) => [e.path, e.status]),
    [
      [NOAH_PATHS.config, 0],
      [NOAH_PATHS.padConfig, 0],
    ],
  );
  assert.equal((await vm.platform.windowsFiles.open(NOAH_PATHS.config)).size, 108);
  assert.equal((await vm.platform.windowsFiles.open(NOAH_PATHS.padConfig)).size, 40);
  await complete(vm.storage);
  assert.equal(vm.storage.poll('write'), 0);
  assert.equal((await vm.platform.windowsFiles.open(NOAH_PATHS.saveData)).size, 0x7b8188);
});
test('existing truncated configuration is not padded with missing-file defaults', async () => {
  const {storage, files} = fixture();
  await files.commit([
    {kind: 'write', path: NOAH_PATHS.config, data: Uint8Array.of(9)},
    {kind: 'write', path: NOAH_PATHS.padConfig, data: Uint8Array.of(8)},
  ]);
  await storage.initializeConfiguration();
  assert.equal(storage.configuration[0], 9);
  assert.equal(storage.configuration[0x6c], 8);
  assert.equal(storage.configuration[0x2d], 0);
  assert.equal(storage.configuration[0x75], 0);
});
test('write failures are reported through native statuses without a false saved result', async () => {
  const {s, files} = fixture();
  const failed = {
    open: (path) => files.open(path),
    commit: async () => {
      throw Object.assign(new Error('quota exhausted'), {code: 'QUOTA'});
    },
  };
  const storage = new SaveStorage(s, failed);
  storage.begin('write');
  await complete(storage);
  assert.equal(storage.poll('write'), 4);
  assert.equal(s.get(0x1bb0384), -2);
  await assert.rejects(files.open(NOAH_PATHS.saveData), /NOT_FOUND/);
});
