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
import {createGroup80Copy} from '../dist/engines/buriko/native/group-80-copy.js';
import {BurikoFileEnumeration} from '../dist/engines/buriko/native/file-enumeration.js';

test('80:2f copies real files with independent readonly clearing, persistent overwrite names and cross-mount contents', async () => {
  const canonical = (path) => path.toLowerCase(),
    backing = new MountedFileSystem();
  const first = new StoredFileSystem(new MemoryStore(), canonical),
    second = new StoredFileSystem(new MemoryStore(), canonical);
  backing.mount('/one', first);
  backing.mount('/two', second);
  await first.commit([{kind: 'write', path: '/Existing Name.txt', data: Uint8Array.of(99)}]);
  const metadata = new BurikoMountedFileMetadata(backing, {
    canonical,
    volumes: [
      {path: '/one', identity: {}, writable: true},
      {path: '/two', identity: {}, writable: true},
    ],
    currentFileTime: () => 20n,
    accessTimePolicy: 'disabled',
    records: [
      ...['/one', '/two'].map((path) => ({
        path,
        kind: 'directory',
        attributes: 16,
        creationTime: 1n,
        accessTime: 1n,
        writeTime: 1n,
      })),
      {
        path: '/one/existing name.txt',
        kind: 'file',
        attributes: 0x21,
        creationTime: 2n,
        accessTime: 3n,
        writeTime: 4n,
      },
    ],
    namespace: {
      entries: [
        {path: '/one/existing name.txt', name: 'Existing Name.txt', shortName: 'EXISTI~1.TXT'},
      ],
      newShortNames: 'disabled',
      fold: (name) => name.toUpperCase(),
    },
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
  await files.write(text.encodeWide('C:\\資料.txt', 1), Uint8Array.of(3, 5, 8));
  await metadata.setTimes('/one/資料.txt', {creationTime: 6n, accessTime: 7n, writeTime: 9n});
  const bytes = new Uint8Array(4096),
    memory = new BurikoBpMemory(bytes),
    thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 16,
      frameCapacity: 16,
    }),
    slot = createGroup80Copy(files)[0];
  const copy = async (source, destination) => {
    bytes.set(text.encodeWide(source, 1), 32);
    bytes.set(text.encodeWide(destination, 1), 256);
    push32(thread, 256);
    push32(thread, 32);
    assert.equal(await slot.execute({thread, memory}), 0);
    const result = pop32(thread);
    assert.equal(thread.stackIndex, 0);
    return result;
  };
  assert.equal(await copy('C:\\資料.txt', 'C:\\existing name.txt'), 1);
  assert.deepEqual(
    await (await files.open(text.encodeWide('C:\\Existing Name.txt', 1))).source.read(0, 3),
    Uint8Array.of(3, 5, 8),
  );
  assert.equal(await metadata.getAttributes('/one/existing name.txt'), 0x20);
  assert.deepEqual(await metadata.getTimes('/one/existing name.txt'), {
    creationTime: 6n,
    accessTime: 7n,
    writeTime: 9n,
  });
  assert.deepEqual(metadata.namespaceSnapshot()[0], {
    path: '/one/existing name.txt',
    name: 'Existing Name.txt',
    shortName: 'EXISTI~1.TXT',
  });
  const enumeration = new BurikoFileEnumeration(files);
  bytes.set(text.encodeWide('C:\\EXISTI~1.TXT', 1), 32);
  assert.equal(
    (await enumeration.enumerate({bytes, offset: 1024}, 1024, {bytes, offset: 32}, false, 0)).count,
    1,
  );
  assert.equal(
    new TextDecoder().decode(bytes.subarray(1024, bytes.indexOf(0, 1024))),
    'Existing Name.txt',
  );
  assert.equal(await copy('C:\\資料.txt', 'D:\\New Copy.txt'), 1);
  assert.deepEqual(
    await (await files.open(text.encodeWide('D:\\New Copy.txt', 1))).source.read(0, 3),
    Uint8Array.of(3, 5, 8),
  );
  assert.deepEqual(await metadata.getTimes('/two/new copy.txt'), {
    creationTime: 6n,
    accessTime: 7n,
    writeTime: 9n,
  });
  // Hidden is not cleared by the wrapper. The readonly preclear remains after CopyFile refuses it.
  await metadata.setAttributes('/one/existing name.txt', 0x23);
  assert.equal(await copy('C:\\資料.txt', 'C:\\Existing Name.txt'), 0);
  assert.equal(await metadata.getAttributes('/one/existing name.txt'), 0x22);
  assert.deepEqual(
    await (await files.open(text.encodeWide('C:\\資料.txt', 1))).source.read(0, 3),
    Uint8Array.of(3, 5, 8),
  );
  assert.deepEqual(
    metadata.namespaceSnapshot().map((entry) => entry.name),
    ['Existing Name.txt', '資料.txt', 'New Copy.txt'],
  );
});
