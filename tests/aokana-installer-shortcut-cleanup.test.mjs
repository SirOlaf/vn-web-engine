import assert from 'node:assert/strict';
import test from 'node:test';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoMountedFileMetadata} from '../dist/engines/buriko/native/file-metadata.js';
import {createGroup80InstallerShortcutCleanup} from '../dist/engines/buriko/native/group-80-installer-shortcut-cleanup.js';
import {BurikoInstallerShortcutCleanup} from '../dist/engines/buriko/native/installer-shortcut-cleanup.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoMountedProgramPaths} from '../dist/engines/buriko/native/program-paths.js';
import {BurikoSpecialFolders} from '../dist/engines/buriko/native/special-folders.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoNativeRegistry} from '../dist/engines/buriko/native/windows-registry.js';

const shortcutPaths = [
  '/desktop/main.lnk',
  '/programs/aokana/main.lnk',
  '/programs/aokana/uninstall.lnk',
];

async function mountedShortcuts() {
  const backing = new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase());
  await backing.commit([
    ...shortcutPaths.map((path) => ({kind: 'write', path, data: new Uint8Array([42])})),
    {kind: 'write', path: '/programs/sibling.lnk', data: new Uint8Array([77])},
  ]);
  const directories = ['/desktop', '/programs', '/programs/aokana'];
  const metadata = new BurikoMountedFileMetadata(backing, {
    records: [
      ...directories.map((path) => ({
        path,
        kind: 'directory',
        attributes: 0x10,
        creationTime: null,
        accessTime: null,
        writeTime: null,
      })),
      ...[...shortcutPaths, '/programs/sibling.lnk'].map((path) => ({
        path,
        kind: 'file',
        attributes: 0x20,
        creationTime: null,
        accessTime: null,
        writeTime: null,
      })),
    ],
    volumes: [{path: '/', identity: {}, writable: true}],
    canonical: (path) => path.toLowerCase(),
    currentFileTime: () => 0n,
    accessTimePolicy: 'disabled',
  });
  const text = new BurikoNativeText();
  const files = new BurikoProgramFiles(
    metadata,
    text,
    new BurikoProgramMedia(),
    new BurikoMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\'),
  );
  const folders = new BurikoSpecialFolders(
    text,
    new BurikoNativeRegistry(new MemoryStore()),
    {primaryRoot: text.encodeWide('C:\\', 1), secondaryRoot: null},
    {
      shellAllocatorAvailable: true,
      windows: null,
      programFiles: null,
      currentUser: {
        desktop: 'C:\\Desktop',
        programs: 'C:\\Programs',
        documents: null,
        profile: null,
      },
      shellUser: {desktop: null, programs: null, documents: null, profile: null},
      elevated: false,
      shellTokenAvailable: false,
      debugPrivilegeAvailable: false,
      shellAccountName: null,
    },
  );
  files.specialFolders = folders;
  return {backing, metadata, files, folders, text};
}

async function invoke(cleanup, text, removeFolder) {
  const memory = new BurikoBpMemory(new Uint8Array(1024));
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 8,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  memory.globalMemory.set(text.encodeWide('Main.lnk', 1), 64);
  memory.globalMemory.set(text.encodeWide('Uninstall.lnk', 1), 192);
  memory.globalMemory.set(text.encodeWide('Buriko', 1), 320);
  const [slot] = createGroup80InstallerShortcutCleanup(cleanup);
  assert.deepEqual([slot.primary, slot.secondary, slot.nativeAddress], [0x80, 0xf6, 0x1400e6160]);
  for (const argument of [64, 192, 320, removeFolder]) push32(thread, argument);
  assert.equal(await slot.execute({thread, memory}), 0);
  assert.equal(thread.stackIndex, 0);
}

test('F6 removes three installer shortcuts through shared mounted folder and metadata owners', async () => {
  const {backing, metadata, files, folders, text} = await mountedShortcuts();
  const cleanup = new BurikoInstallerShortcutCleanup(folders, files);
  assert.equal(cleanup.metadata, metadata);
  const order = [];
  const query = folders.query.bind(folders);
  folders.query = async (output, selector) => {
    order.push(`folder:${selector}`);
    return query(output, selector);
  };
  const deleteFile = metadata.deleteFile.bind(metadata);
  metadata.deleteFile = async (path) => {
    order.push(`delete:${path}`);
    return deleteFile(path);
  };
  await invoke(cleanup, text, 1);
  assert.deepEqual(order, [
    'folder:1',
    'delete:/Desktop/Main.lnk',
    'folder:2',
    'delete:/Programs/Buriko/Main.lnk',
    'delete:/Programs/Buriko/Uninstall.lnk',
  ]);
  for (const path of shortcutPaths) await assert.rejects(backing.open(path), /NOT_FOUND/);
  await assert.rejects(metadata.stat('/programs/aokana'), /NOT_FOUND/);
  assert.equal((await metadata.stat('/desktop')).kind, 'directory');
  assert.equal((await metadata.stat('/programs')).kind, 'directory');
  assert.deepEqual(
    new Uint8Array(await (await backing.open('/programs/sibling.lnk')).read(0, 1)),
    new Uint8Array([77]),
  );
});

test('F6 flag zero keeps the now-empty Programs subfolder', async () => {
  const {backing, metadata, files, folders, text} = await mountedShortcuts();
  await invoke(new BurikoInstallerShortcutCleanup(folders, files), text, 0);
  for (const path of shortcutPaths) await assert.rejects(backing.open(path), /NOT_FOUND/);
  assert.equal((await metadata.stat('/programs/aokana')).kind, 'directory');
});
