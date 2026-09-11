import {
  StoredFileSystem,
  MountedFileSystem,
  SourceFileSystem,
  readFile,
} from '../dist/platform/filesystem.js';
import {
  StoredRegistry,
  REG,
  registryDword,
  registryQword,
  registryString,
} from '../dist/platform/registry.js';
import {BlobSource} from '../dist/core/source.js';
export function equal(a, b, why = 'values differ') {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${why}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}
export async function rejects(fn, pattern) {
  try {
    await fn();
  } catch (e) {
    if (!pattern.test(String(e))) throw e;
    return;
  }
  throw new Error(`Expected failure: ${pattern}`);
}
export async function storageContract(store) {
  const fs = new StoredFileSystem(store),
    reg = new StoredRegistry(store),
    key = {hive: 'HKCU', view: '32', path: 'Software\\Test'};
  const bytes = Uint8Array.of(0, 255, 128, 13, 10);
  await fs.commit([{kind: 'write', path: '/saves/1', data: bytes}]);
  bytes[0] = 99;
  equal([...(await readFile(fs, '/saves/1'))], [0, 255, 128, 13, 10]);
  const opened = await fs.open('/saves/1');
  equal([...(await opened.read(1, 2))], [255, 128]);
  await rejects(() => opened.read(4, 2), /range/);
  await fs.commit([
    {kind: 'write', path: '/saves/1', data: Uint8Array.of(5)},
    {kind: 'write', path: '/settings', data: new Uint8Array()},
  ]);
  equal([...(await opened.read(0, 5))], [0, 255, 128, 13, 10], 'open handles are snapshots');
  equal(
    (await fs.list('/')).map((e) => [e.path, e.kind]),
    [
      ['/saves', 'directory'],
      ['/settings', 'file'],
    ],
  );
  await rejects(
    () =>
      fs.commit([
        {kind: 'write', path: '/saves/1', data: Uint8Array.of(6)},
        {kind: 'delete', path: '/missing'},
      ]),
    /NOT_FOUND/,
  );
  equal([...(await readFile(fs, '/saves/1'))], [5], 'batch rollback');
  for (const p of [
    '/../escape',
    '/a/../x',
    '/a//b',
    '/a/',
    'relative',
    'C:\\test',
    '/a\0b',
    '/a:b',
    '/a\\b',
  ])
    await rejects(() => fs.open(p), /INVALID_PATH/);
  await rejects(() => fs.commit([{kind: 'write', path: '/saves', data: bytes}]), /IS_DIRECTORY/);
  await rejects(
    () => fs.commit([{kind: 'write', path: '/settings/child', data: bytes}]),
    /NOT_DIRECTORY/,
  );
  await rejects(() => fs.open('/saves'), /IS_DIRECTORY/);
  await rejects(() => fs.list('/settings'), /NOT_DIRECTORY/);
  await rejects(() => readFile(fs, '/saves/1', 0), /limit/);
  const sources = new SourceFileSystem(),
    blob = new BlobSource(new Blob([Uint8Array.of(42)]));
  sources.attach('/a.cpk', blob);
  equal((await sources.open('/a.cpk')) === blob, true, 'preserve transferable sources');
  const mounted = new MountedFileSystem();
  mounted.mount('/game', sources);
  mounted.mount('/user', fs);
  equal([...(await readFile(mounted, '/game/a.cpk'))], [42]);
  await rejects(
    () => mounted.commit([{kind: 'write', path: '/game/a.cpk', data: bytes}]),
    /READ_ONLY/,
  );
  await rejects(
    () =>
      mounted.commit([
        {kind: 'write', path: '/user/new', data: bytes},
        {kind: 'write', path: '/game/a.cpk', data: bytes},
      ]),
    /CROSS_MOUNT/,
  );
  await rejects(() => mounted.stat('/user/new'), /NOT_FOUND/);
  await rejects(() => mounted.open('/user2/settings'), /NOT_FOUND/);
  equal(
    (await mounted.list('/user')).map((i) => i.path),
    ['/user/saves', '/user/settings'],
  );
  await reg.createKey(key);
  await reg.createKey({...key, path: 'software\\test'});
  await reg.setValue(key, 'Volume', registryDword(0xffffffff));
  await reg.setValue(key, '', registryString('日本語 🎮'));
  await reg.setValue(key, 'Raw', {type: 12345, data: Uint8Array.of(255, 0, 254)});
  const caseKey = {...key, path: 'SOFTWARE\\TEST'};
  equal([...(await reg.getValue(caseKey, 'vOLUME')).data], [255, 255, 255, 255]);
  equal(
    (await reg.enumerate(key)).values.map((v) => v.name),
    ['Volume', '', 'Raw'],
  );
  await reg.setValue(caseKey, 'VOLUME', registryDword(10));
  equal((await reg.enumerate(key)).values[0].name, 'Volume');
  equal(await reg.getValue(key, 'missing'), undefined);
  equal(await reg.hasKey({...key, view: '64'}), false);
  equal(await reg.hasKey({...key, hive: 'HKLM'}), false);
  await rejects(() => reg.getValue({...key, path: 'Other'}, ''), /NOT_FOUND/);
  await rejects(() => reg.setValue({...key, path: 'Missing'}, '', registryDword(1)), /NOT_FOUND/);
  await rejects(() => reg.createKey({...key, path: '日本語'}), /UNSUPPORTED_NAME/);
  await rejects(() => reg.createKey({...key, path: 'Bad\\\\Path'}), /INVALID_NAME/);
  await reg.createKey({...key, path: 'Software\\Test\\Child'});
  await rejects(() => reg.deleteKey(key), /NOT_EMPTY/);
  equal((await reg.enumerate(key)).subkeys, ['Child']);
  await reg.deleteValue(key, 'raw');
  await rejects(() => reg.deleteValue(key, 'raw'), /NOT_FOUND/);
  const q = registryQword(0xffffffffffffffffn);
  equal(q.type, REG.QWORD);
  equal([...q.data], Array(8).fill(255));
  const text = registryString('A');
  equal([...text.data], [65, 0, 0, 0]);
  await rejects(() => registryDword(2 ** 32), /INVALID_VALUE/);
  await rejects(() => registryQword(-1n), /INVALID_VALUE/);
  await reg.setValue(key, 'MalformedSZ', {type: REG.SZ, data: Uint8Array.of(65)});
  equal(
    [...(await reg.getValue(key, 'MalformedSZ')).data],
    [65],
    'raw registry bytes are not silently repaired',
  );
  await store.update((records) => {
    records.set('counter', Uint8Array.of(0));
  });
  await Promise.all(
    Array.from({length: 12}, () =>
      store.update((records) => {
        records.set('counter', Uint8Array.of(records.get('counter')[0] + 1));
      }),
    ),
  );
  equal([...(await store.snapshot()).get('counter')], [12]);
  await rejects(
    () =>
      store.update((records) => {
        records.set('counter', Uint8Array.of(99));
        throw new Error('injected rollback');
      }),
    /injected rollback/,
  );
  equal([...(await store.snapshot()).get('counter')], [12]);
  const snapshot = await store.snapshot();
  snapshot.get('counter')[0] = 99;
  equal([...(await store.snapshot()).get('counter')], [12]);
  await reg.deleteKey(key, true);
  equal(await reg.hasKey(key), false);
  equal(await reg.hasKey({...key, path: 'Software'}), true);
  equal([...(await readFile(fs, '/saves/1'))], [5], 'registry deletion cannot delete files');
  await fs.commit([
    {kind: 'delete', path: '/settings'},
    {kind: 'delete', path: '/saves/1'},
  ]);
  equal(await fs.list('/'), []);
}
