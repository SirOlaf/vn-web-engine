import test from 'node:test';
import assert from 'node:assert/strict';
import {
  noahPaths,
  NOAH_PATHS,
  NOAH_WINDOWS,
} from '../dist/engines/mages/games/chaos-head-noah/paths.js';
import {windowsLayout} from '../dist/platform/windows-layout.js';
import {WindowsFileSystem, windowsFileKey} from '../dist/platform/windows-filesystem.js';
import {
  MountedFileSystem,
  StoredFileSystem,
  SourceFileSystem,
  readFile,
} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {StoredAchievements} from '../dist/platform/achievements.js';
function setup(options = NOAH_WINDOWS) {
  const store = new MemoryStore(),
    files = new MountedFileSystem();
  files.mount('/user', new StoredFileSystem(store, windowsFileKey));
  files.mount('/game', new SourceFileSystem(windowsFileKey));
  return {store, files, win: new WindowsFileSystem(files, options)};
}
test('NOAH native Documents paths retain case/separator aliases and installation mount', async () => {
  const {files, win} = setup();
  assert.equal(
    NOAH_PATHS.directory,
    'C:\\Users\\Player\\Documents\\My Games\\Mages Inc\\CHAOS;HEAD NOAH',
  );
  for (const [i, path] of [NOAH_PATHS.config, NOAH_PATHS.padConfig, NOAH_PATHS.saveData].entries())
    await win.commit([{kind: 'write', path, data: Uint8Array.of(i + 1)}]);
  assert.deepEqual([...(await readFile(win, NOAH_PATHS.directory + '\\\\config.dat'))], [1]);
  assert.deepEqual(
    [...(await readFile(win, NOAH_PATHS.padConfig.toLowerCase().replaceAll('\\', '/')))],
    [2],
  );
  assert.equal(
    win.resolve(NOAH_PATHS.saveData).virtual,
    '/user/drives/C/USERS/PLAYER/DOCUMENTS/MY GAMES/MAGES INC/CHAOS;HEAD NOAH/SAVEDATA.DAT',
  );
  assert.equal(win.resolve('Data\\script.cpk').virtual, '/game/DATA/SCRIPT.CPK');
  await assert.rejects(
    win.commit([{kind: 'write', path: 'Data\\script.cpk', data: new Uint8Array()}]),
    /READ_ONLY/,
  );
  assert.deepEqual(
    [...(await readFile(new WindowsFileSystem(files, NOAH_WINDOWS), NOAH_PATHS.saveData))],
    [3],
  );
});
test('drives, directories, redirected Documents and host metadata cannot collide', async () => {
  const {store, files, win} = setup(windowsLayout(NOAH_PATHS.installation, ['C:', 'D:']));
  const paths = [
    NOAH_PATHS.config,
    noahPaths('D:\\Documents').config,
    'C:\\Other\\CONFIG.DAT',
    'D:\\Other\\CONFIG.DAT',
  ];
  for (const [i, path] of paths.entries())
    await win.commit([{kind: 'write', path, data: Uint8Array.of(i)}]);
  for (const [i, path] of paths.entries()) assert.deepEqual([...(await readFile(win, path))], [i]);
  await assert.rejects(win.open('E:\\Other\\CONFIG.DAT'), /NOT_FOUND/);
  const achievements = new StoredAchievements(store, 'chaos-head-noah');
  await achievements.load();
  achievements.unlock(31);
  await achievements.settle();
  const reloaded = new StoredAchievements(store, 'chaos-head-noah');
  await reloaded.load();
  assert.equal(reloaded.has(31), true);
  assert.equal((await store.snapshot()).size, 5);
  assert.ok((await store.snapshot()).has('host:achievements:chaos-head-noah'));
  assert.equal((await files.list('/user')).length, 1);
});

test('achievement identities separate games even in a shared store and retain concurrent unlocks', async () => {
  const store = new MemoryStore(),
    a = new StoredAchievements(store, 'chaos-head-noah'),
    b = new StoredAchievements(store, 'another-game'),
    other = new StoredAchievements(store, 'chaos-head-noah');
  assert.equal(a.identifier(31), 'chaos-head-noah:31');
  assert.equal(b.identifier(31), 'another-game:31');
  a.unlock(31);
  other.unlock(32);
  b.unlock(1);
  await Promise.all([a.settle(), other.settle(), b.settle()]);
  const reopen = new StoredAchievements(store, 'chaos-head-noah');
  await reopen.load();
  assert.ok(reopen.has(31));
  assert.ok(reopen.has(32));
  assert.equal(reopen.has(1), false);
  await b.load();
  assert.equal(b.has(31), false);
});
