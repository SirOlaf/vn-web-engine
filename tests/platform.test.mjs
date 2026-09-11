import test from 'node:test';
import {MemoryStore, IndexedDbStore} from '../dist/platform/store.js';
import {storageContract, rejects, equal} from './platform-contract.mjs';
test('filesystem, mounts, registry and atomic store contract (memory)', async () => {
  const store = new MemoryStore();
  await storageContract(store);
  store.close();
  await rejects(() => store.snapshot(), /closed/);
  await rejects(() => store.update(() => {}), /closed/);
});
test('persistent adapter cannot silently fall back when IndexedDB is unavailable', async () => {
  await rejects(() => IndexedDbStore.open(['test'], null), /unavailable/);
});
test('transaction callbacks cannot leak mutable references into the store', async () => {
  const store = new MemoryStore();
  let held;
  await store.update((r) => {
    held = r;
    r.set('x', Uint8Array.of(1));
  });
  held.get('x')[0] = 9;
  equal([...(await store.snapshot()).get('x')], [1]);
  await rejects(() => store.update(() => Promise.resolve()), /synchronous/);
});

test('Windows paths resolve drives, UNC, relative names and case without touching host files', async () => {
  const {MountedFileSystem, StoredFileSystem, SourceFileSystem, readFile} =
    await import('../dist/platform/filesystem.js');
  const {WindowsFileSystem, windowsFileKey} =
    await import('../dist/platform/windows-filesystem.js');
  const {BlobSource} = await import('../dist/core/source.js');
  const game = new SourceFileSystem(windowsFileKey),
    files = new MountedFileSystem(),
    store = new MemoryStore();
  game.attach('/Data/Movie.cpk', new BlobSource(new Blob([Uint8Array.of(42)])));
  files.mount('/game', game);
  files.mount('/user', new StoredFileSystem(store, windowsFileKey));
  const win = new WindowsFileSystem(files, {
    cwd: 'C:\\Game',
    mounts: [
      {windows: 'C:\\Game', virtual: '/game'},
      {windows: 'C:\\Users\\Player', virtual: '/user'},
      {windows: '\\\\server\\share', virtual: '/user'},
      {windows: 'D:\\', virtual: '/user'},
    ],
    driveDirectories: {'D:': 'D:\\Saves'},
  });
  for (const p of [
    'C:\\Game\\Data\\Movie.cpk',
    'c:/game/data/movie.CPK',
    'Data\\movie.cpk',
    'C:Data\\movie.cpk',
    '\\Game\\Data\\Movie.cpk',
    'C:\\..\\Game\\Data\\Movie.cpk',
    'Data\\other\\..\\Movie.cpk',
    'Data\\Movie.cpk. ',
  ])
    equal([...(await readFile(win, p))], [42], p);
  await win.commit([
    {kind: 'write', path: 'C:\\Users\\Player\\Save.DAT', data: Uint8Array.of(1, 2)},
  ]);
  equal([...(await readFile(win, '\\\\SERVER\\SHARE\\save.dat'))], [1, 2]);
  equal([...(await readFile(files, '/user/save.dat'))], [1, 2]);
  await win.commit([{kind: 'write', path: 'd:slot.dat', data: Uint8Array.of(7)}]);
  equal([...(await readFile(files, '/user/saves/SLOT.DAT'))], [7]);
  await win.chdir('C:\\Game\\Data');
  equal([...(await readFile(win, 'movie.cpk'))], [42]);
  equal([...(await readFile(win, 'C:movie.cpk'))], [42]);
  equal((await win.list('.'))[0].path, 'C:\\GAME\\DATA\\MOVIE.CPK');
  await rejects(
    () => win.commit([{kind: 'write', path: 'movie.cpk', data: Uint8Array.of(9)}]),
    /READ_ONLY/,
  );
  for (const p of ['Z:\\anything', 'C:\\Windows\\win.ini', '\\\\other\\share\\x', 'C:\\Game2\\x'])
    await rejects(() => win.open(p), /NOT_FOUND/);
  await rejects(() => win.open('Z:file'), /current directory/);
  for (const p of [
    'C:\\Game\\NUL',
    '\\\\?\\C:\\Game\\x',
    '\\\\.\\pipe\\x',
    'C:\\Game\\x:stream',
    'C:\\Game\\a\0b',
  ])
    await rejects(() => win.open(p), /unsupported|INVALID_PATH/);
  await rejects(() => win.open('C:\\Game\\日本語'), /casing policy/);
  await Promise.all(
    ['Save.dat', 'SAVE.DAT', 'save.DAT'].map((n, i) =>
      win.commit([{kind: 'write', path: 'D:\\' + n, data: Uint8Array.of(i)}]),
    ),
  );
  equal(
    (await files.list('/user')).filter((e) => e.path.endsWith('/SAVE.DAT')).length,
    1,
    'case aliases cannot create separate saves',
  );
});
