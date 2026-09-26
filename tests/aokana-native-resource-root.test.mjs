import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoMountedFileMetadata} from '../dist/engines/buriko/native/file-metadata.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoMountedProgramPaths} from '../dist/engines/buriko/native/program-paths.js';
import {BurikoProgramResources} from '../dist/engines/buriko/native/program-resources.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoResourceFileServices} from '../dist/engines/buriko/native/resource-file-services.js';
import {createGroup80ResourceFiles} from '../dist/engines/buriko/native/group-80-resource-files.js';
import {createGroup80ResourceRead} from '../dist/engines/buriko/native/group-80-resource-read.js';
import {createGroup80ResourceSettings} from '../dist/engines/buriko/native/group-80-resource-settings.js';
import {BurikoSpecialFolders} from '../dist/engines/buriko/native/special-folders.js';
import {BurikoNativeRegistry} from '../dist/engines/buriko/native/windows-registry.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
import {BurikoEngineErrors} from '../dist/engines/buriko/native/engine-errors.js';
import {BurikoEngineDialogs} from '../dist/engines/buriko/native/engine-dialogs.js';

test('80:3e changes the shared encoded/wide resource roots consumed by file, read, availability and root-query services', async () => {
  const canonical = (p) => p.toLowerCase(),
    metadata = new BurikoMountedFileMetadata(new StoredFileSystem(new MemoryStore(), canonical), {
      canonical,
      volumes: [{path: '/', identity: {}, writable: true}],
      records: [
        {
          path: '/',
          kind: 'directory',
          attributes: 16,
          creationTime: 1n,
          accessTime: 1n,
          writeTime: 1n,
        },
      ],
      currentFileTime: () => 2n,
      accessTimePolicy: 'disabled',
    });
  await metadata.createDirectory('/old');
  await metadata.createDirectory('/資料');
  const text = new BurikoNativeText(),
    media = new BurikoProgramMedia();
  media.setDriveType(2, 3);
  const paths = new BurikoMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\old'),
    files = new BurikoProgramFiles(metadata, text, media, paths);
  await files.write(text.encodeWide('C:\\資料\\Asset.bin', 1), Uint8Array.of(9, 7, 5));
  const dialogs = new BurikoEngineDialogs(),
    errors = new BurikoEngineErrors(files, dialogs, Uint8Array.of(0), Uint8Array.of(0)),
    processing = new BurikoDistributedProcessing(new BurikoDistributedAllocator(1), 1);
  const config = {
    nativeFileRoot: 'C:\\old\\',
    primaryRoot: text.encodeWide('C:\\old\\', 1),
    secondaryRoot: Uint8Array.of(0),
    secondaryMediaPath: '',
    searchDirectoriesEnabled: 0,
    searchDirectories: [],
    retryTitle: Uint8Array.of(0),
    retryMessage: Uint8Array.of(0),
    quitConfirmation: Uint8Array.of(0),
  };
  const resources = new BurikoProgramResources(files, config, dialogs, errors, processing);
  const user = {desktop: null, programs: null, documents: null, profile: null};
  const folders = new BurikoSpecialFolders(
    text,
    new BurikoNativeRegistry(new MemoryStore()),
    config,
    {
      shellAllocatorAvailable: false,
      windows: null,
      programFiles: null,
      currentUser: user,
      shellUser: user,
      elevated: false,
      shellTokenAvailable: false,
      debugPrivilegeAvailable: false,
      shellAccountName: null,
    },
  );
  const slots = [
    ...createGroup80ResourceSettings(resources, folders),
    ...createGroup80ResourceRead(resources),
    ...createGroup80ResourceFiles(new BurikoResourceFileServices(resources)),
  ];
  const bytes = new Uint8Array(4096),
    memory = new BurikoBpMemory(bytes),
    thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 16,
      frameCapacity: 16,
    });
  const invoke = async (slot, ...args) => {
    for (const value of args) push32(thread, value);
    assert.equal(await slots.find((s) => s.secondary === slot).execute({thread, memory}), 0);
    const result = pop32(thread);
    assert.equal(thread.stackIndex, 0);
    return result;
  };
  const original = text.encodeWide('C:\\資料\\', 0);
  bytes.set(original, 32);
  assert.equal(await invoke(0x3e, 32), 1);
  const expected = Uint8Array.from([...original.subarray(0, -1), 92, 0]);
  assert.deepEqual(config.primaryRoot, expected);
  assert.equal(config.nativeFileRoot, 'C:\\資料\\\\');
  assert.equal(paths.currentDirectory, 'C:\\old');
  assert.equal(await invoke(0x3d, 512, 0), 1);
  assert.deepEqual(bytes.subarray(512, 512 + expected.length), expected);
  bytes.set(text.encodeWide('Asset.bin', 1), 256);
  assert.equal(await invoke(0x34, 0, 256), 1);
  assert.equal(await invoke(0x30, 1024, 0, 256), 3);
  assert.deepEqual(Array.from(bytes.subarray(1024, 1027)), [9, 7, 5]);
  bytes.set(text.encodeWide('New.bin', 1), 256);
  bytes.set([2, 4], 1500);
  assert.equal(await invoke(0x32, 256, 1500, 2), 1);
  assert.deepEqual(
    await (await files.open(text.encodeWide('C:\\資料\\New.bin', 1))).source.read(0, 2),
    Uint8Array.of(2, 4),
  );
  bytes.set(text.encodeWide('C:\\missing', 1), 32);
  assert.equal(await invoke(0x3e, 32), 0);
  assert.deepEqual(config.primaryRoot, expected);
  processing.dispose();
});
