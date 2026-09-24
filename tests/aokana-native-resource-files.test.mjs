import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {AokanaBpMemory} from '../dist/engines/buriko/games/aokana/bp/memory.js';
import {AokanaBpThread, pop32, push32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {AokanaMountedFileMetadata} from '../dist/engines/buriko/games/aokana/native/file-metadata.js';
import {
  AokanaProgramFiles,
  AokanaProgramMedia,
} from '../dist/engines/buriko/games/aokana/native/program-files.js';
import {AokanaMountedProgramPaths} from '../dist/engines/buriko/games/aokana/native/program-paths.js';
import {AokanaProgramResources} from '../dist/engines/buriko/games/aokana/native/program-resources.js';
import {AokanaResourceRanges} from '../dist/engines/buriko/games/aokana/native/resource-ranges.js';
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaResourceFileServices} from '../dist/engines/buriko/games/aokana/native/resource-file-services.js';
import {createGroup80ResourceFiles} from '../dist/engines/buriko/games/aokana/native/group-80-resource-files.js';
import {
  AokanaDistributedAllocator,
  AokanaDistributedProcessing,
} from '../dist/engines/buriko/games/aokana/native/distributed-processing.js';
import {AokanaEngineErrors} from '../dist/engines/buriko/games/aokana/native/engine-errors.js';
import {AokanaEngineDialogs} from '../dist/engines/buriko/games/aokana/native/engine-dialogs.js';

test('80:32–34 share configured wide roots, real output lifetime, media and archive availability', async () => {
  const canonical = (p) => p.toLowerCase(),
    backing = new StoredFileSystem(new MemoryStore(), canonical);
  const metadata = new AokanaMountedFileMetadata(backing, {
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
  for (const path of ['/save', '/save/extra', '/archives', '/disc'])
    await metadata.createDirectory(path);
  const text = new AokanaNativeText(),
    media = new AokanaProgramMedia();
  media.setDriveType(2, 3);
  const files = new AokanaProgramFiles(
    metadata,
    text,
    media,
    new AokanaMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\'),
  );
  // These services never invoke a modal. Real error/dialog owners are retained, without a fake answer provider.
  const dialogs = new AokanaEngineDialogs(),
    errors = new AokanaEngineErrors(
      files,
      dialogs,
      text.encodeWide('C:\\save\\', 1),
      text.encodeWide('C:\\save\\', 1),
    );
  const processing = new AokanaDistributedProcessing(new AokanaDistributedAllocator(1), 1);
  const config = {
    nativeFileRoot: 'C:\\save\\',
    primaryRoot: text.encodeWide('C:\\archives\\', 1),
    secondaryRoot: text.encodeWide('C:\\disc\\', 1),
    secondaryMediaPath: 'C:\\disc\\',
    searchDirectoriesEnabled: 1,
    searchDirectories: [text.encodeWide('extra', 1)],
    retryTitle: Uint8Array.of(0),
    retryMessage: Uint8Array.of(0),
    quitConfirmation: Uint8Array.of(0),
  };
  const resources = new AokanaProgramResources(files, config, dialogs, errors, processing),
    ranges = new AokanaResourceRanges(resources);
  const bytes = new Uint8Array(4096),
    memory = new AokanaBpMemory(bytes),
    thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 16,
      frameCapacity: 16,
    }),
    slots = createGroup80ResourceFiles(new AokanaResourceFileServices(resources));
  const put = (offset, value) => bytes.set(text.encodeWide(value, 1), offset);
  const invoke = async (slot, ...args) => {
    for (const value of args) push32(thread, value);
    assert.equal(await slots.find((s) => s.secondary === slot).execute({thread, memory}), 0);
    const result = pop32(thread);
    assert.equal(thread.stackIndex, 0);
    return result;
  };
  put(32, '資料.bin');
  bytes.set([1, 3, 5, 7], 1024);
  assert.equal(await invoke(0x32, 32, 1024, 4), 1);
  assert.deepEqual(
    await (await files.open(text.encodeWide('C:\\save\\資料.bin', 1))).source.read(0, 4),
    Uint8Array.of(1, 3, 5, 7),
  );
  assert.equal(await invoke(0x32, 32, 1024, 2), 1);
  assert.equal((await files.open(text.encodeWide('C:\\save\\資料.bin', 1))).source.size, 2);
  assert.equal(await invoke(0x34, 0, 32), 1);
  assert.equal(await ranges.isAvailable(null, text.encodeWide('資料.bin', 1)), true);
  assert.equal(await invoke(0x33, 0, 32), 1);
  assert.equal(await invoke(0x34, 0, 32), 0);
  put(32, 'C:\\save\\Empty.bin');
  assert.equal(await invoke(0x32, 32, 0, 0), 1);
  assert.equal(await invoke(0x34, 0, 32), 1);
  assert.equal(await invoke(0x33, 32, 0), 1);
  await files.write(text.encodeWide('C:\\save\\extra\\Found.bin', 1), Uint8Array.of(9));
  put(32, 'Found.bin');
  assert.equal(await invoke(0x34, 0, 32), 1);
  await files.write(text.encodeWide('C:\\disc\\Secondary.bin', 1), Uint8Array.of(8));
  put(32, 'Secondary.bin');
  assert.equal(await invoke(0x34, 0, 32), 1);
  const archive = new Uint8Array(272);
  archive.set(new TextEncoder().encode('BURIKO ARC20'));
  new DataView(archive.buffer).setUint32(12, 2, true);
  archive.set(new TextEncoder().encode('Zero'), 16);
  archive.set(new TextEncoder().encode('C:\\Member'), 144);
  await files.write(text.encodeWide('C:\\archives\\Data.arc', 1), archive);
  put(32, 'Zero');
  put(256, 'Data.arc');
  assert.equal(await invoke(0x34, 256, 32), 1);
  assert.equal(
    await ranges.isAvailable(text.encodeWide('Data.arc', 1), text.encodeWide('Zero', 1)),
    true,
  );
  assert.equal(await invoke(0x34, 0, 32), 0);
  put(32, 'C:\\Member');
  assert.equal(await invoke(0x34, 256, 32), 1);
  processing.dispose();
});
