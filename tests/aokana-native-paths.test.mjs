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
import {AokanaNativeText} from '../dist/engines/buriko/games/aokana/native/text.js';
import {AokanaPathFileDirectory} from '../dist/engines/buriko/games/aokana/native/path-file-directory.js';
import {createGroup80Paths} from '../dist/engines/buriko/games/aokana/native/group-80-paths.js';

test('80 path services share mounted directories, file flags and lexical UTF-8 split outputs', async () => {
  const canonical = (path) => path.toLowerCase();
  const backing = new StoredFileSystem(new MemoryStore(), canonical);
  const metadata = new AokanaMountedFileMetadata(backing, {
    canonical,
    volumes: [{path: '/', identity: {}, writable: true}],
    records: [
      {
        path: '/',
        kind: 'directory',
        attributes: 0x10,
        creationTime: 1n,
        accessTime: 1n,
        writeTime: 1n,
      },
    ],
    currentFileTime: () => 2n,
    accessTimePolicy: 'disabled',
  });
  const text = new AokanaNativeText();
  const files = new AokanaProgramFiles(
    metadata,
    text,
    new AokanaProgramMedia(),
    new AokanaMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\'),
  );
  const service = new AokanaPathFileDirectory(files);
  assert.equal(service.metadata, files.metadata);
  const definitions = createGroup80Paths(service);
  assert.deepEqual(
    definitions.map((entry) => entry.secondary),
    [0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d],
  );
  const bytes = new Uint8Array(4096);
  const memory = new AokanaBpMemory(bytes);
  const thread = new AokanaBpThread({
    id: 1,
    operandCapacity: 16,
    moduleCapacity: 16,
    frameCapacity: 16,
  });
  const context = {thread, memory};
  const put = (address, value) => bytes.set(text.encodeWide(value, 1), address);
  const read = (address) =>
    new TextDecoder().decode(bytes.subarray(address, bytes.indexOf(0, address)));
  const invoke = async (slot, ...arguments_) => {
    for (const value of arguments_) push32(thread, value);
    assert.equal(await definitions.find((entry) => entry.secondary === slot).execute(context), 0);
    const result = pop32(thread);
    assert.equal(thread.stackIndex, 0);
    return result;
  };
  put(32, 'C:\\save');
  put(128, 'C:\\save\\state.bin');
  assert.equal(await invoke(0x28, 32), 1);
  assert.equal(await invoke(0x2a, 32), 1);
  assert.equal(await invoke(0x2c, 32), 0x10);
  assert.equal(await invoke(0x2d, 32, 0x22), 1);
  assert.equal(await invoke(0x2c, 32), 0x32);
  assert.equal(await metadata.getAttributes('/save'), 0x32);
  assert.equal(
    await files.write(text.encodeWide('C:\\save\\state.bin', 1), Uint8Array.of(3, 7, 11)),
    3,
  );
  assert.equal(await invoke(0x2a, 128), 0);
  assert.equal(await invoke(0x2c, 128), 0x20);
  assert.equal(await invoke(0x2d, 128, 0x21), 1);
  assert.equal(await invoke(0x2c, 128), 0x21);
  // Another existing owner consumes these flags: read-only content cannot be overwritten.
  assert.equal(await files.write(text.encodeWide('C:\\save\\state.bin', 1), Uint8Array.of(99)), 0);
  const opened = await files.open(text.encodeWide('C:\\save\\state.bin', 1));
  assert.deepEqual(await files.read(opened.source, 0, 3), Uint8Array.of(3, 7, 11));
  assert.equal(await invoke(0x29, 32), 0);
  assert.equal(await invoke(0x2d, 128, 0x80), 1);
  await metadata.deleteFile('/save/state.bin');
  assert.equal(await invoke(0x29, 32), 1);
  assert.equal(await invoke(0x2a, 32), 0);
  assert.equal(await invoke(0x2c, 32), 0xffffffff);
  assert.deepEqual(await metadata.list('/'), []);

  // Split is lexical, keeps slash spelling and uses UTF-8 regardless of the source encoding.
  bytes.set(text.encodeWide('C:\\資料.dir/場面.tar.gz', 0), 256);
  assert.equal(await invoke(0x2b, 1024, 1280, 1536, 1792, 256), 1);
  assert.deepEqual([1024, 1280, 1536, 1792].map(read), ['C:', '\\資料.dir/', '場面.tar', '.gz']);
  put(256, '\\\\server\\share\\.config');
  assert.equal(await invoke(0x2b, 1024, 1280, 1536, 1792, 256), 1);
  assert.deepEqual([1024, 1280, 1536, 1792].map(read), ['', '\\\\server\\share\\', '', '.config']);
  put(256, 'relative');
  assert.equal(await invoke(0x2b, 0, 0, 1536, 0, 256), 1);
  assert.equal(read(1536), 'relative');
  assert.equal(await invoke(0x2b, 1024, 1280, 1536, 1792, 0), 0);
  assert.equal(read(1536), 'relative');
});
