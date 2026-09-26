import test from 'node:test';
import assert from 'node:assert/strict';
import {StoredFileSystem, MountedFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoBpThread, pop32, push32} from '../dist/engines/buriko/bp/state.js';
import {BurikoMountedFileMetadata} from '../dist/engines/buriko/native/file-metadata.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoMountedProgramPaths} from '../dist/engines/buriko/native/program-paths.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {BurikoFileEnumeration} from '../dist/engines/buriko/native/file-enumeration.js';
import {createGroup80Move} from '../dist/engines/buriko/native/group-80-move.js';

test('80:27 moves real shared directory trees and copies files between independent mounted stores', async () => {
  const canonical = (path) => path.toLowerCase(),
    backing = new MountedFileSystem();
  backing.mount('/one', new StoredFileSystem(new MemoryStore(), canonical));
  backing.mount('/two', new StoredFileSystem(new MemoryStore(), canonical));
  let now = 2n;
  const metadata = new BurikoMountedFileMetadata(backing, {
    canonical,
    volumes: [
      {path: '/one', identity: {}, writable: true},
      {path: '/two', identity: {}, writable: true},
    ],
    currentFileTime: () => now,
    accessTimePolicy: 'disabled',
    records: ['/one', '/two'].map((path) => ({
      path,
      kind: 'directory',
      attributes: 16,
      creationTime: 1n,
      accessTime: 1n,
      writeTime: 1n,
    })),
    namespace: {entries: [], newShortNames: 'disabled', fold: (name) => name.toUpperCase()},
    move: {
      contents: 'ordinary-single-stream',
      security: 'unsupported',
      copiedTimes: 'preserve-source',
      copyDeleteFailure: 'success-retain-source',
    },
  });
  const text = new BurikoNativeText(),
    files = new BurikoProgramFiles(
      metadata,
      text,
      new BurikoProgramMedia(),
      new BurikoMountedProgramPaths(
        [
          {native: 'C:\\', mounted: '/one'},
          {native: 'D:\\', mounted: '/two'},
        ],
        'C:\\',
      ),
    );
  await metadata.createDirectory('/one/Source');
  await metadata.createDirectory('/one/Source/Empty');
  await files.write(text.encodeWide('C:\\Source\\資料.txt', 1), Uint8Array.of(11, 23));
  await metadata.setTimes('/one/source/資料.txt', {
    creationTime: 5n,
    accessTime: 7n,
    writeTime: 9n,
  });
  await metadata.setAttributes('/one/source/資料.txt', 0x22);
  const bytes = new Uint8Array(4096),
    memory = new BurikoBpMemory(bytes),
    thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 16,
      frameCapacity: 16,
    }),
    slot = createGroup80Move(files)[0];
  const move = async (source, destination) => {
    bytes.set(text.encodeWide(source, 1), 32);
    bytes.set(text.encodeWide(destination, 1), 256);
    push32(thread, 256);
    push32(thread, 32);
    assert.equal(await slot.execute({thread, memory}), 0);
    const result = pop32(thread);
    assert.equal(thread.stackIndex, 0);
    return result;
  };
  now = 12n;
  assert.equal(await move('C:\\Source', 'C:\\Renamed'), 1);
  assert.equal((await files.open(text.encodeWide('C:\\Source\\資料.txt', 1))).source, null);
  assert.equal((await metadata.stat('/one/renamed/empty')).kind, 'directory');
  await metadata.createDirectory('/one/Source');
  assert.deepEqual(await metadata.list('/one/source'), []);
  await metadata.removeDirectory('/one/source');
  const opened = await files.open(text.encodeWide('C:\\Renamed\\資料.txt', 1));
  assert.deepEqual(await opened.source.read(0, 2), Uint8Array.of(11, 23));
  assert.deepEqual(await metadata.getTimes('/one/renamed/資料.txt'), {
    creationTime: 5n,
    accessTime: 7n,
    writeTime: 9n,
  });
  assert.equal(await metadata.getAttributes('/one/renamed/資料.txt'), 0x22);
  const enumeration = new BurikoFileEnumeration(files);
  bytes.set(text.encodeWide('C:\\Renamed\\*', 1), 32);
  assert.deepEqual(
    await enumeration.enumerate({bytes, offset: 1024}, 1024, {bytes, offset: 32}, false, 0),
    {count: 1, size: new TextEncoder().encode('資料.txt\0').length},
  );
  assert.equal(new TextDecoder().decode(bytes.subarray(1024, bytes.indexOf(0, 1024))), '資料.txt');
  now = 20n;
  assert.equal(await move('C:\\Renamed\\資料.txt', 'D:\\Transferred.txt'), 1);
  assert.equal((await files.open(text.encodeWide('C:\\Renamed\\資料.txt', 1))).source, null);
  assert.deepEqual(
    await (await files.open(text.encodeWide('D:\\Transferred.txt', 1))).source.read(0, 2),
    Uint8Array.of(11, 23),
  );
  assert.deepEqual(await metadata.getTimes('/two/transferred.txt'), {
    creationTime: 5n,
    accessTime: 7n,
    writeTime: 9n,
  });
  assert.equal(await metadata.getAttributes('/two/transferred.txt'), 0x22);
  await files.write(text.encodeWide('C:\\Another.txt', 1), Uint8Array.of(31));
  assert.equal(await move('C:\\Another.txt', 'D:\\Transferred.txt'), 0);
  assert.deepEqual(
    await (await files.open(text.encodeWide('C:\\Another.txt', 1))).source.read(0, 1),
    Uint8Array.of(31),
  );
  assert.deepEqual(
    metadata.namespaceSnapshot().map((entry) => entry.name),
    ['Renamed', 'Empty', 'Transferred.txt', 'Another.txt'],
  );
});
