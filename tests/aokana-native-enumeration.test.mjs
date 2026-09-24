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
import {AokanaFileEnumeration} from '../dist/engines/buriko/games/aokana/native/file-enumeration.js';
import {createGroup80Enumeration} from '../dist/engines/buriko/games/aokana/native/group-80-enumeration.js';

test('80 enumeration uses the live shared namespace, imported aliases and ordered recursive packed names', async () => {
  const canonical = (value) => value.toLowerCase(),
    backing = new StoredFileSystem(new MemoryStore(), canonical);
  await backing.commit([{kind: 'write', path: '/Long Name.txt', data: Uint8Array.of(1, 2)}]);
  const metadata = new AokanaMountedFileMetadata(backing, {
    canonical,
    volumes: [{path: '/', identity: {}, writable: true}],
    currentFileTime: () => 2n,
    accessTimePolicy: 'disabled',
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
    namespace: {
      entries: [{path: '/Long Name.txt', name: 'Long Name.txt', shortName: 'LONGNA~1.TXT'}],
      newShortNames: 'disabled',
      fold: (value) => value.toUpperCase(),
    },
  });
  const text = new AokanaNativeText(),
    files = new AokanaProgramFiles(
      metadata,
      text,
      new AokanaProgramMedia(),
      new AokanaMountedProgramPaths([{native: 'C:\\', mounted: '/'}], 'C:\\'),
    );
  await metadata.createDirectory('/Child');
  await metadata.createDirectory('/Empty');
  await files.write(text.encodeWide('C:\\Child\\資料.txt', 1), Uint8Array.of(3));
  await files.write(text.encodeWide('C:\\Child\\Second.txt', 1), Uint8Array.of(4));
  const definitions = createGroup80Enumeration(new AokanaFileEnumeration(files));
  const bytes = new Uint8Array(4096),
    memory = new AokanaBpMemory(bytes),
    thread = new AokanaBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 16,
      frameCapacity: 16,
    });
  const put = (value) => bytes.set(text.encodeWide(value, 1), 32);
  const invoke = async (slot, ...args) => {
    for (const value of args) push32(thread, value);
    assert.equal(await definitions.find((d) => d.secondary === slot).execute({memory, thread}), 0);
    const result = pop32(thread);
    assert.equal(thread.stackIndex, 0);
    return result;
  };
  const packed = (count) => {
    let at = 1024;
    const names = [];
    for (let i = 0; i < count; i++) {
      const end = bytes.indexOf(0, at);
      names.push(new TextDecoder().decode(bytes.subarray(at, end)));
      at = end + 1;
    }
    return names;
  };
  put('C:\\*.txt');
  assert.equal(await invoke(0x24, 32, 1), 3);
  // The parent reaches maximum one; the child receives zero, which means unlimited.
  assert.equal(await invoke(0x25, 1024, 2048, 32, 1, 1), 3);
  assert.deepEqual(packed(3), ['Long Name.txt', 'Child\\資料.txt', 'Child\\Second.txt']);
  assert.equal(
    await invoke(0x25, 0, 0, 32, 1, 1),
    new TextEncoder().encode('Long Name.txt\0Child\\資料.txt\0Child\\Second.txt\0').length,
  );
  put('C:\\LONGNA~1.TXT');
  assert.equal(await invoke(0x25, 1024, 2048, 32, 0, 0), 1);
  assert.deepEqual(packed(1), ['Long Name.txt']);
  put('C:\\*.*');
  assert.equal(await invoke(0x26, 1024, 2048, 32, 0), 2);
  assert.deepEqual(packed(2), ['Child', 'Empty']);
  await metadata.removeDirectory('/Empty');
  await files.write(text.encodeWide('C:\\Fresh', 1), Uint8Array.of(5));
  await metadata.replaceFile('/Fresh', '/Renamed');
  put('C:\\*.*');
  assert.equal(await invoke(0x25, 1024, 2048, 32, 0, 0), 2);
  assert.deepEqual(packed(2), ['Long Name.txt', 'Renamed']);
  await metadata.deleteFile('/Renamed');
  put('C:\\Child\\*.txt');
  assert.equal(await invoke(0x25, 1024, 2048, 32, 0, 1), 1);
  assert.deepEqual(packed(1), ['資料.txt']);
  put('C:\\no-match.txt');
  assert.equal(await invoke(0x24, 32, 1), 0);
  assert.deepEqual(
    await (await files.open(text.encodeWide('C:\\Long Name.txt', 1))).source.read(0, 2),
    Uint8Array.of(1, 2),
  );
  assert.deepEqual(
    metadata.namespaceSnapshot().map((entry) => entry.name),
    ['Long Name.txt', 'Child', '資料.txt', 'Second.txt'],
  );
});
