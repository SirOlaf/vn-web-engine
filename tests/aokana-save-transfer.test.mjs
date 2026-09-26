import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoSaveTransfer} from '../dist/engines/buriko/save-transfer.js';

test('Buriko save transfer uses the native save names and persistent game/user byte stores', async () => {
  const stores = {game: new MemoryStore(), user: new MemoryStore()};
  const transfer = new BurikoSaveTransfer(async (area) => ({
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

test('Buriko save transfer recognizes only JewelryHeartsAcademia UserData SUD files', async () => {
  const stores = {game: new MemoryStore(), user: new MemoryStore()},
    transfer = new BurikoSaveTransfer(async (area) => ({
      snapshot: () => stores[area].snapshot(),
      update: (change) => stores[area].update(change),
      close() {},
    }));
  await stores.game.update((records) => {
    records.set('file:/USERDATA/JEWELRYHEARTSACADEMIA007.SUD', Uint8Array.of(7));
    records.set('file:/USERDATA/JEWELRYHEARTSACADEMIA1000.SUD', Uint8Array.of(10));
    records.set('file:/USERDATA/JEWELRYHEARTSACADEMIA-01.SUD', Uint8Array.of(11));
    records.set('file:/USERDATA/NOT_IDENTIFIER.SUD', Uint8Array.of(8));
    records.set('file:/USERDATA/IDENTIFIER007.SUD', Uint8Array.of(12));
    records.set('file:/OTHER/JEWELRYHEARTSACADEMIA008.SUD', Uint8Array.of(9));
  });
  await stores.user.update((records) => {
    records.set('file:/USERDATA/JEWELRYHEARTSACADEMIA009.SUD', Uint8Array.of(9));
  });
  const found = await transfer.list();
  assert.deepEqual(
    found.map(({area, path, kind}) => [area, path, kind]),
    [
      ['game', '/USERDATA/JEWELRYHEARTSACADEMIA-01.SUD', 'user-data'],
      ['game', '/USERDATA/JEWELRYHEARTSACADEMIA007.SUD', 'user-data'],
      ['game', '/USERDATA/JEWELRYHEARTSACADEMIA1000.SUD', 'user-data'],
    ],
  );
  assert.deepEqual([...(await transfer.read(found[1]))], [7]);

  const imported = await transfer.import('JewelryHeartsAcademia008.sud', Uint8Array.of(8));
  assert.equal(imported.area, 'game');
  assert.equal(imported.path, '/USERDATA/JEWELRYHEARTSACADEMIA008.SUD');
  assert.equal(imported.kind, 'user-data');
  assert.deepEqual([...(await transfer.read(imported))], [8]);
  await assert.rejects(
    transfer.import('IDENTIFIER007.sud', Uint8Array.of(1)),
    /JewelryHeartsAcademia/,
  );
  await assert.rejects(
    transfer.import('JewelryHeartsAcademia1.sud', Uint8Array.of(1)),
    /JewelryHeartsAcademia/,
  );
  await assert.rejects(
    transfer.read({area: 'game', path: '/OTHER/JEWELRYHEARTSACADEMIA008.SUD'}),
    /JewelryHeartsAcademia/,
  );
  await assert.rejects(
    transfer.read({area: 'user', path: '/USERDATA/JEWELRYHEARTSACADEMIA009.SUD'}),
    /JewelryHeartsAcademia/,
  );
});
