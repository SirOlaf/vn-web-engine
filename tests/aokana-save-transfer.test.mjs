import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaSaveTransfer} from '../dist/engines/buriko/games/aokana/save-transfer.js';

test('Aokana save transfer uses the native save names and persistent game/user byte stores', async () => {
  const stores = {game: new MemoryStore(), user: new MemoryStore()};
  const transfer = new AokanaSaveTransfer(async (area) => ({
    snapshot: () => stores[area].snapshot(),
    update: (change) => stores[area].update(change),
    close() {},
  }));

  await stores.game.update((records) => {
    records.set('file:/SYSTEM.ARC', Uint8Array.of(9));
  });
  const imported = await transfer.import('BGI0007.cad', Uint8Array.of(1, 2, 3));
  assert.equal(imported.path, '/BGI0007.CAD');
  assert.deepEqual([...(await transfer.read(imported))], [1, 2, 3]);
  await transfer.import('BGI.gdb', Uint8Array.of(4), {
    area: 'user',
    path: '/Documents/BGI.gdb',
  });
  assert.deepEqual(
    (await transfer.list()).map(({area, path, size}) => [area, path, size]),
    [
      ['user', '/DOCUMENTS/BGI.GDB', 1],
      ['game', '/BGI0007.CAD', 3],
    ],
  );
  await assert.rejects(transfer.import('system.arc', Uint8Array.of(1)), /BGI/);
  await assert.rejects(
    transfer.import('BGI0001.cad', Uint8Array.of(1), {
      area: 'game',
      path: '/../BGI0001.cad',
    }),
    /INVALID_PATH/,
  );
});
