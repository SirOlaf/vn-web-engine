import assert from 'node:assert/strict';
import test from 'node:test';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoMountedFileMetadata} from '../dist/engines/buriko/native/file-metadata.js';
import {BurikoInstallerManifestActions} from '../dist/engines/buriko/native/installer-manifest-actions.js';
import {createGroup80InstallerManifest} from '../dist/engines/buriko/native/group-80-installer-manifest.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoMountedProgramPaths} from '../dist/engines/buriko/native/program-paths.js';
import {BurikoProgramResources} from '../dist/engines/buriko/native/program-resources.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';

const bytes = (value) => new TextEncoder().encode(value);

async function mountedManifest(contents) {
  const backing = new StoredFileSystem(new MemoryStore(), (path) => path.toLowerCase());
  await backing.commit([
    {kind: 'write', path: '/install/uninst.lst', data: bytes(contents)},
    {kind: 'write', path: '/install/keep.bin', data: bytes('retained')},
    {kind: 'write', path: '/install/old.bin', data: bytes('removed')},
  ]);
  const metadata = new BurikoMountedFileMetadata(backing, {
      records: [
        {
          path: '/install',
          kind: 'directory',
          attributes: 0x10,
          creationTime: null,
          accessTime: null,
          writeTime: null,
        },
        ...['uninst.lst', 'keep.bin', 'old.bin'].map((name) => ({
          path: `/install/${name}`,
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
    }),
    text = new BurikoNativeText(),
    files = new BurikoProgramFiles(
      metadata,
      text,
      new BurikoProgramMedia(),
      new BurikoMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\'),
    ),
    unavailable = () => assert.fail('ordinary manifest action opened an engine error'),
    resources = new BurikoProgramResources(
      files,
      {
        nativeFileRoot: 'C:\\install\\',
        primaryRoot: bytes('C:\\install\\\0'),
        secondaryRoot: Uint8Array.of(0),
        secondaryMediaPath: '',
        searchDirectoriesEnabled: 0,
        searchDirectories: [],
        retryTitle: bytes('Retry\0'),
        retryMessage: bytes('Retry\0'),
        quitConfirmation: bytes('Quit\0'),
      },
      {show: unavailable},
      {fatal: unavailable, threadFatal: unavailable},
      new BurikoDistributedProcessing(new BurikoDistributedAllocator(1), 1),
    );
  return {backing, metadata, resources, actions: new BurikoInstallerManifestActions(resources)};
}

async function read(files, path) {
  const opened = await files.open(path);
  return new Uint8Array(await opened.read(0, opened.size));
}

async function invoke(actions, secondary, root, entries) {
  const memory = new BurikoBpMemory(new Uint8Array(2048));
  const thread = new BurikoBpThread({
    id: 1,
    operandCapacity: 8,
    moduleCapacity: 0,
    frameCapacity: 0,
  });
  const list = new DataView(memory.globalMemory.buffer);
  memory.globalMemory.set(root, 64);
  entries.forEach((entry, index) => {
    const offset = 256 + index * 128;
    memory.globalMemory.set(entry, offset);
    list.setUint32(128 + index * 4, offset, true);
  });
  const slot = createGroup80InstallerManifest(actions).find((item) => item.secondary === secondary);
  assert.ok(slot);
  push32(thread, 64);
  push32(thread, 128);
  assert.equal(await slot.execute({thread, memory}), 0);
  const result = pop32(thread);
  assert.equal(thread.stackIndex, 0);
  return {slot, result};
}

test('F4 lower deletes only unlisted ordinary manifest files through the mounted metadata owner', async () => {
  const {backing, resources, actions} = await mountedManifest(
    'keep.bin\nold.bin\n@BGIError.txt\nuninst.lst\n\0',
  );
  assert.equal(actions.resources, resources);
  const {slot, result} = await invoke(actions, 0xf4, bytes('C:\\install\0'), [bytes('keep.bin\0')]);
  assert.deepEqual([slot.primary, slot.nativeAddress, result], [0x80, 0x1400e6290, 1]);
  assert.deepEqual(await read(backing, '/install/keep.bin'), bytes('retained'));
  assert.deepEqual(
    await read(backing, '/install/uninst.lst'),
    bytes('keep.bin\nold.bin\n@BGIError.txt\nuninst.lst\n\0'),
  );
  await assert.rejects(backing.open('/install/old.bin'), /NOT_FOUND/);
});

test('F5 lower merges normalized manifest records and writes LF records with a final NUL', async () => {
  const {metadata, resources, actions} = await mountedManifest(
    '  KEEP.BIN\r\n$SubDir\nkeep.bin\n\0',
  );
  assert.equal(actions.resources.files.metadata, metadata);
  const {slot, result} = await invoke(actions, 0xf5, bytes('C:\\install\0'), [
    bytes('NEW.BIN\0'),
    bytes('KEEP.BIN\0'),
  ]);
  assert.deepEqual([slot.primary, slot.nativeAddress, result], [0x80, 0x1400e61d0, 1]);
  assert.deepEqual(
    await read(metadata, '/install/uninst.lst'),
    bytes('keep.bin\nnew.bin\n$subdir\n\0'),
  );
});
